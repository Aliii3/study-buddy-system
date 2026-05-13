import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { Pool } from "pg";
import type { AvailabilitySlot, Match, NotificationItem, Profile, ServiceKey, StudySession, User } from "@/types/domain";

export const dynamic = "force-dynamic";

type StoredUser = User & { passwordHash: string };

type Store = {
  users: StoredUser[];
  profiles: Profile[];
  availability: AvailabilitySlot[];
  sessions: StudySession[];
  notifications: NotificationItem[];
  matches: Match[];
};

type GraphQLBody = {
  query?: string;
  variables?: Record<string, unknown>;
};

type TokenPayload = {
  user: User;
  iat: number;
};

const globalStore = globalThis as typeof globalThis & { studyBuddyStore?: Store };

const globalDatabase = globalThis as typeof globalThis & {
  studyBuddyPool?: Pool;
  studyBuddyDatabaseReady?: boolean;
};

function createInitialStore() {
  const demoUser = createUser({
    name: "Demo Student",
    email: "demo@studybuddy.local",
    password: "password",
    university: "Study Buddy University",
    academicYear: 3,
    phone: ""
  });

  return {
    users: [demoUser],
    profiles: [
      {
        userId: demoUser.id,
        courses: ["CS 301", "MATH 230"],
        topics: ["Algorithms", "Proofs"],
        studyPace: "Balanced",
        studyMode: "Hybrid",
        groupSize: 3,
        studyStyle: "Quiet deep work"
      }
    ],
    availability: [
      { id: randomUUID(), userId: demoUser.id, dayOfWeek: "Monday", startTime: "10:00", endTime: "12:00" },
      { id: randomUUID(), userId: demoUser.id, dayOfWeek: "Wednesday", startTime: "14:00", endTime: "16:00" }
    ],
    sessions: [],
    notifications: [
      {
        id: randomUUID(),
        userId: demoUser.id,
        type: "WELCOME",
        message: "Your Vercel serverless backend is connected.",
        isRead: false,
        metadata: null,
        createdAt: new Date().toISOString()
      }
    ],
    matches: []
  } satisfies Store;
}

async function getStore() {
  if (process.env.DATABASE_URL) {
    const databaseStore = await getDatabaseStore();
    globalStore.studyBuddyStore = databaseStore;
    return databaseStore;
  }

  if (!globalStore.studyBuddyStore) {
    globalStore.studyBuddyStore = createInitialStore();
  }

  return globalStore.studyBuddyStore;
}

async function saveStore(store: Store) {
  globalStore.studyBuddyStore = store;
  if (!process.env.DATABASE_URL) return;

  await getPool().query(
    `
      INSERT INTO study_buddy_state (id, state, updated_at)
      VALUES ('default', $1::jsonb, now())
      ON CONFLICT (id)
      DO UPDATE SET state = EXCLUDED.state, updated_at = now()
    `,
    [JSON.stringify(store)]
  );
}

async function getDatabaseStore() {
  await ensureDatabase();
  const result = await getPool().query<{ state: Store }>("SELECT state FROM study_buddy_state WHERE id = 'default'");
  return normalizeStore(result.rows[0]?.state || createInitialStore());
}

async function ensureDatabase() {
  if (globalDatabase.studyBuddyDatabaseReady) return;

  await getPool().query(`
    CREATE TABLE IF NOT EXISTS study_buddy_state (
      id text PRIMARY KEY,
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await getPool().query(
    `
      INSERT INTO study_buddy_state (id, state)
      VALUES ('default', $1::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [JSON.stringify(createInitialStore())]
  );

  globalDatabase.studyBuddyDatabaseReady = true;
}

function getPool() {
  if (!globalDatabase.studyBuddyPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not configured");

    globalDatabase.studyBuddyPool = new Pool({
      connectionString,
      ssl: connectionString.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined
    });
  }

  return globalDatabase.studyBuddyPool;
}

function normalizeStore(store: Partial<Store>): Store {
  return {
    users: store.users || [],
    profiles: store.profiles || [],
    availability: store.availability || [],
    sessions: store.sessions || [],
    notifications: store.notifications || [],
    matches: store.matches || []
  };
}

const ACTIVE_SESSION_STATUSES = ["SCHEDULED", "UPDATED"];

function usersAreStudyBuddies(userIdA: string, userIdB: string, store: Store): boolean {
  if (userIdA === userIdB) return true;
  return store.matches.some(
    (m) =>
      (m.userId === userIdA && m.matchedUserId === userIdB) ||
      (m.userId === userIdB && m.matchedUserId === userIdA)
  );
}

function isStudySessionVisibleForUser(session: StudySession, user: User): boolean {
  const participants = session.participants || [];
  if (
    session.userId === user.id ||
    session.creatorId === user.id ||
    session.receiverId === user.id ||
    participants.some((p) => p.userId === user.id)
  ) {
    return true;
  }
  // Joinable sessions from anyone in the app (shared roster). Matches the deployed study-session
  // microservice, which lists all sessions, and avoids hidden state when users skip "Compute matches".
  return ACTIVE_SESSION_STATUSES.includes(session.status);
}

function computeRealisticMatches(store: Store, userId: string): Match[] {
  const profileA = store.profiles.find((p) => p.userId === userId);
  if (!profileA) return [];

  const now = new Date().toISOString();
  const results: Match[] = [];

  for (const other of store.users) {
    if (other.id === userId) continue;
    const profileB = store.profiles.find((p) => p.userId === other.id);
    if (!profileB) continue;

    const coursesA = profileA.courses || [];
    const coursesB = profileB.courses || [];
    const topicsA = profileA.topics || [];
    const topicsB = profileB.topics || [];
    const sharedCourses = coursesA.filter((c) => coursesB.includes(c));
    const sharedTopics = topicsA.filter((t) => topicsB.includes(t));

    const slotsA = store.availability.filter((s) => s.userId === userId);
    const slotsB = store.availability.filter((s) => s.userId === other.id);
    const daysA = new Set(slotsA.map((s) => s.dayOfWeek));
    const overlapAvail = slotsB.some((s) => daysA.has(s.dayOfWeek));

    let raw = 0;
    const reasons: string[] = [];
    if (sharedCourses.length) {
      raw += Math.min(sharedCourses.length, 2) * 20;
      reasons.push(`Shared courses: ${sharedCourses.slice(0, 2).join(", ")}`);
    }
    if (sharedTopics.length) {
      raw += Math.min(sharedTopics.length, 2) * 10;
      reasons.push(`Shared topics: ${sharedTopics.slice(0, 2).join(", ")}`);
    }
    if (overlapAvail) {
      raw += 20;
      reasons.push("Overlapping availability");
    }
    if (profileA.studyMode && profileA.studyMode === profileB.studyMode) {
      raw += 10;
      reasons.push(`Same study mode: ${profileA.studyMode}`);
    }
    if (profileA.studyPace && profileA.studyPace === profileB.studyPace) {
      raw += 5;
      reasons.push(`Same study pace: ${profileA.studyPace}`);
    }
    if (profileA.studyStyle && profileA.studyStyle === profileB.studyStyle) {
      raw += 5;
      reasons.push("Same study style");
    }

    if (raw <= 0) continue;
    results.push({
      id: randomUUID(),
      userId,
      matchedUserId: other.id,
      score: Math.min(raw, 100) / 100,
      reasons,
      status: "RECOMMENDED",
      createdAt: now,
      updatedAt: now
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

export async function POST(request: Request, { params }: { params: { service: ServiceKey } }) {
  try {
    const body = (await request.json()) as GraphQLBody;
    const query = body.query || "";
    const variables = body.variables || {};
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null;
    const store = await getStore();
    const currentUser = token ? readToken(token)?.user || null : null;

    const data = handleOperation(params.service, query, variables, store, currentUser);
    await saveStore(store);
    return NextResponse.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GraphQL request failed";
    // HTTP 200 so Apollo parses `errors` and clients can show the real message (400 becomes a generic HttpLink error).
    return NextResponse.json({ data: null, errors: [{ message }] }, { status: 200 });
  }
}

function handleOperation(service: ServiceKey, query: string, variables: Record<string, unknown>, store: Store, currentUser: User | null) {
  if (service === "user") return handleUser(query, variables, store, currentUser);
  if (service === "profile") return handleProfile(query, variables, store, requireUser(currentUser));
  if (service === "availability") return handleAvailability(query, variables, store, requireUser(currentUser));
  if (service === "session") return handleSession(query, variables, store, requireUser(currentUser));
  if (service === "notification") return handleNotification(query, variables, store, requireUser(currentUser));
  if (service === "matching") return handleMatching(query, variables, store, requireUser(currentUser));

  throw new Error("Unknown service");
}

function handleUser(query: string, variables: Record<string, unknown>, store: Store, currentUser: User | null) {
  if (query.includes("getMe")) {
    const user = requireUser(currentUser);
    upsertRecoveredUser(store, user);
    return { getMe: user };
  }

  if (query.includes("register")) {
    const email = String(variables.email || "").trim().toLowerCase();
    if (!email || !variables.password) throw new Error("Email and password are required");
    if (store.users.some((user) => user.email.toLowerCase() === email)) throw new Error("User already exists");

    const user = createUser({
      name: String(variables.name || ""),
      email,
      password: String(variables.password),
      university: String(variables.university || ""),
      academicYear: Number(variables.academicYear || 1),
      phone: optionalString(variables.phone)
    });
    store.users.push(user);
    store.notifications.push(createNotification(user.id, "WELCOME", "Welcome to Study Buddy. Complete your profile to improve matches."));
    return { register: stripPassword(user) };
  }

  if (query.includes("login")) {
    const email = String(variables.email || "").trim().toLowerCase();
    const passwordHash = hashPassword(String(variables.password || ""));
    const user = store.users.find((item) => item.email.toLowerCase() === email && item.passwordHash === passwordHash);
    if (!user) throw new Error("Invalid credentials");

    const publicUser = stripPassword(user);
    return { login: { token: createToken(publicUser), user: publicUser } };
  }

  throw new Error("Unsupported user operation");
}

function handleProfile(query: string, variables: Record<string, unknown>, store: Store, user: User) {
  if (query.includes("getProfile")) {
    return { getProfile: store.profiles.find((profile) => profile.userId === user.id) || null };
  }

  if (query.includes("updateProfile")) {
    const profile: Profile = {
      userId: user.id,
      courses: stringArray(variables.courses),
      topics: stringArray(variables.topics),
      studyPace: optionalString(variables.studyPace) || "Balanced",
      studyMode: optionalString(variables.studyMode) || "Hybrid",
      groupSize: Number(variables.groupSize || 3),
      studyStyle: optionalString(variables.studyStyle) || "Quiet deep work"
    };
    store.profiles = [profile, ...store.profiles.filter((item) => item.userId !== user.id)];
    return { updateProfile: profile };
  }

  throw new Error("Unsupported profile operation");
}

function handleAvailability(query: string, variables: Record<string, unknown>, store: Store, user: User) {
  if (query.includes("getAvailability")) {
    // Shared roster (like sessions): everyone sees all weekly blocks for scheduling context.
    return { getAvailability: [...store.availability].sort((a, b) => a.userId.localeCompare(b.userId) || a.dayOfWeek.localeCompare(b.dayOfWeek)) };
  }

  if (query.includes("createSlot")) {
    validateSlot(variables.dayOfWeek, variables.startTime, variables.endTime);
    const slot: AvailabilitySlot = {
      id: randomUUID(),
      userId: user.id,
      dayOfWeek: String(variables.dayOfWeek),
      startTime: String(variables.startTime),
      endTime: String(variables.endTime)
    };
    ensureNoAvailabilityOverlap(store.availability, slot);
    store.availability.unshift(slot);
    return { createSlot: slot };
  }

  if (query.includes("updateSlot")) {
    const slot = store.availability.find((item) => item.id === variables.id && item.userId === user.id);
    if (!slot) throw new Error("Slot not found");
    const updated: AvailabilitySlot = {
      ...slot,
      dayOfWeek: optionalString(variables.dayOfWeek) || slot.dayOfWeek,
      startTime: optionalString(variables.startTime) || slot.startTime,
      endTime: optionalString(variables.endTime) || slot.endTime
    };
    validateSlot(updated.dayOfWeek, updated.startTime, updated.endTime);
    ensureNoAvailabilityOverlap(store.availability.filter((item) => item.id !== updated.id), updated);
    store.availability = store.availability.map((item) => (item.id === updated.id ? updated : item));
    return { updateSlot: updated };
  }

  if (query.includes("deleteSlot")) {
    const slot = store.availability.find((item) => item.id === variables.id && item.userId === user.id);
    if (!slot) throw new Error("Slot not found");
    store.availability = store.availability.filter((item) => item.id !== slot.id);
    return { deleteSlot: slot };
  }

  throw new Error("Unsupported availability operation");
}

function handleSession(query: string, variables: Record<string, unknown>, store: Store, user: User) {
  if (query.includes("getStudySessions")) {
    return { getStudySessions: store.sessions.filter((session) => isStudySessionVisibleForUser(session, user)) };
  }

  if (query.includes("createStudySession")) {
    const startTime = String(variables.startTime);
    const endTime = String(variables.endTime);
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("Invalid session time range");

    const now = new Date().toISOString();
    const session: StudySession = {
      id: randomUUID(),
      title: String(variables.title || "Study session"),
      description: optionalString(variables.description),
      topic: String(variables.topic || ""),
      startTime,
      endTime,
      durationMinutes: Math.round((end.getTime() - start.getTime()) / 60000),
      sessionType: String(variables.sessionType || "ONLINE"),
      status: "SCHEDULED",
      creatorId: user.id,
      receiverId: null,
      creatorContact: String(variables.creatorContact || user.email),
      receiverContact: null,
      userId: user.id,
      subject: String(variables.subject || ""),
      participants: [{ id: randomUUID(), sessionId: "", userId: user.id, contactInfo: String(variables.creatorContact || user.email), joinedAt: now }],
      createdAt: now,
      updatedAt: now
    };
    session.participants = session.participants.map((participant) => ({ ...participant, sessionId: session.id }));
    store.sessions.unshift(session);
    store.notifications.push(createNotification(user.id, "SESSION_CREATED", `Session created: ${session.title}`));
    for (const other of store.users) {
      if (other.id === user.id) continue;
      if (usersAreStudyBuddies(user.id, other.id, store)) {
        store.notifications.push(
          createNotification(other.id, "SESSION_INVITE", `${user.name} scheduled a study session: ${session.title}`)
        );
      }
    }
    return { createStudySession: session };
  }

  if (query.includes("joinStudySession")) {
    const id = String(variables.id || "");
    const joinUserId = String(variables.userId || "");
    const contactInfo = String(variables.contactInfo || user.email);
    const session = store.sessions.find((item) => item.id === id);
    if (!session) throw new Error("Session not found");
    if (!["SCHEDULED", "UPDATED"].includes(session.status)) throw new Error("Study session is not active");
    if (joinUserId !== user.id) throw new Error("Forbidden");
    const now = new Date().toISOString();
    const existing = session.participants.find((participant) => participant.userId === joinUserId);
    if (!existing) {
      session.participants.push({
        id: randomUUID(),
        sessionId: id,
        userId: joinUserId,
        contactInfo,
        joinedAt: now
      });
    } else {
      existing.contactInfo = contactInfo;
    }
    if (joinUserId !== session.creatorId) {
      session.receiverId = session.receiverId || joinUserId;
      session.receiverContact = session.receiverContact || contactInfo;
    }
    session.status = "UPDATED";
    session.updatedAt = now;
    if (session.creatorId !== user.id) {
      store.notifications.push(
        createNotification(session.creatorId, "SESSION_INVITE", `${user.name} joined your session: ${session.title}`)
      );
    }
    return { joinStudySession: session };
  }

  if (query.includes("leaveStudySession")) {
    const id = String(variables.id || "");
    const leaveUserId = String(variables.userId || "");
    const session = store.sessions.find((item) => item.id === id);
    if (!session) throw new Error("Session not found");
    if (!["SCHEDULED", "UPDATED"].includes(session.status)) throw new Error("Study session is not active");
    if (leaveUserId !== user.id) throw new Error("Forbidden");
    if (leaveUserId === session.creatorId) throw new Error("Creator cannot leave their own session. Cancel it instead.");
    session.participants = session.participants.filter((participant) => participant.userId !== leaveUserId);
    if (session.receiverId === leaveUserId) {
      session.receiverId = null;
      session.receiverContact = null;
    }
    session.status = "UPDATED";
    session.updatedAt = new Date().toISOString();
    return { leaveStudySession: session };
  }

  if (query.includes("cancelStudySession")) {
    const id = String(variables.id || "");
    const session = store.sessions.find((item) => item.id === id);
    if (!session) throw new Error("Session not found");
    if (session.creatorId !== user.id) throw new Error("Forbidden");
    if (!["SCHEDULED", "UPDATED"].includes(session.status)) throw new Error("Study session is not active");
    session.status = "CANCELLED";
    session.updatedAt = new Date().toISOString();
    return { cancelStudySession: session };
  }

  throw new Error("Unsupported session operation");
}

function handleNotification(query: string, variables: Record<string, unknown>, store: Store, user: User) {
  const userId = String(variables.userId || user.id);
  if (userId !== user.id) throw new Error("Forbidden");

  if (query.includes("getNotifications")) {
    return { getNotifications: store.notifications.filter((notification) => notification.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }

  if (query.includes("markNotificationAsRead") && !query.includes("markAllNotificationsAsRead")) {
    const id = String(variables.id || "");
    const notification = store.notifications.find((item) => item.id === id && item.userId === user.id);
    if (!notification) throw new Error("Notification not found");
    notification.isRead = true;
    return { markNotificationAsRead: notification };
  }

  if (query.includes("markAllNotificationsAsRead")) {
    store.notifications = store.notifications.map((notification) => (notification.userId === user.id ? { ...notification, isRead: true } : notification));
    return { markAllNotificationsAsRead: true };
  }

  throw new Error("Unsupported notification operation");
}

function handleMatching(query: string, variables: Record<string, unknown>, store: Store, user: User) {
  const userId = String(variables.userId || user.id);
  if (userId !== user.id) throw new Error("Forbidden");

  if (query.includes("getRecommendedMatches")) {
    return { getRecommendedMatches: store.matches.filter((match) => match.userId === user.id) };
  }

  if (query.includes("getUserProfile")) {
    const userId = String(variables.userId || "");
    const profile = store.profiles.find((item) => item.userId === userId);
    if (!profile) {
      return { getUserProfile: null };
    }
    return {
      getUserProfile: {
        id: profile.userId,
        userId: profile.userId,
        courses: profile.courses,
        topics: profile.topics,
        studyPace: profile.studyPace,
        studyMode: profile.studyMode,
        groupSize: profile.groupSize,
        studyStyle: profile.studyStyle
      }
    };
  }

  if (query.includes("computeMatches")) {
    const matches = computeRealisticMatches(store, user.id);
    store.matches = [...matches, ...store.matches.filter((match) => match.userId !== user.id)];
    if (matches.length) {
      store.notifications.push(createNotification(user.id, "MATCH_FOUND", "New study buddy recommendations are ready."));
    }
    return { computeMatches: matches };
  }

  throw new Error("Unsupported matching operation");
}

function requireUser(user: User | null) {
  if (!user) throw new Error("Not authenticated");
  return user;
}

function createUser(data: { name: string; email: string; password: string; university: string; academicYear: number; phone?: string | null }): StoredUser {
  return {
    id: randomUUID(),
    name: data.name,
    email: data.email,
    university: data.university,
    academicYear: data.academicYear,
    phone: data.phone || null,
    passwordHash: hashPassword(data.password)
  };
}

function stripPassword(user: StoredUser): User {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

function upsertRecoveredUser(store: Store, user: User) {
  if (store.users.some((item) => item.id === user.id)) return;
  store.users.push({ ...user, passwordHash: "" });
}

function createNotification(userId: string, type: string, message: string): NotificationItem {
  return {
    id: randomUUID(),
    userId,
    type,
    message,
    isRead: false,
    metadata: null,
    createdAt: new Date().toISOString()
  };
}

function createToken(user: User) {
  const payload = base64UrlEncode(JSON.stringify({ user, iat: Date.now() } satisfies TokenPayload));
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

function readToken(token: string): TokenPayload | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    return JSON.parse(base64UrlDecode(payload)) as TokenPayload;
  } catch {
    return null;
  }
}

function sign(value: string) {
  return createHmac("sha256", process.env.AUTH_SECRET || "study-buddy-local-secret").update(value).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function hashPassword(password: string) {
  return createHmac("sha256", process.env.AUTH_SECRET || "study-buddy-local-secret").update(password).digest("hex");
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function validateSlot(dayOfWeek: unknown, startTime: unknown, endTime: unknown) {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  if (!days.includes(String(dayOfWeek))) throw new Error("Invalid day of week");
  if (!isClockTime(String(startTime)) || !isClockTime(String(endTime))) throw new Error("Use HH:mm format");
  if (String(endTime) <= String(startTime)) throw new Error("Start time must be before end time");
}

function ensureNoAvailabilityOverlap(slots: AvailabilitySlot[], candidate: AvailabilitySlot) {
  const overlap = slots.some((slot) => {
    return slot.userId === candidate.userId && slot.dayOfWeek === candidate.dayOfWeek && candidate.startTime < slot.endTime && candidate.endTime > slot.startTime;
  });
  if (overlap) throw new Error("Slot overlaps with an existing slot");
}

function isClockTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
