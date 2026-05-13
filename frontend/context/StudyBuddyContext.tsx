"use client";

import { createContext, useContext } from "react";

export type StudyBuddyActions = {
  token: string | null;
  refresh: () => Promise<void>;
};

const StudyBuddyContext = createContext<StudyBuddyActions | null>(null);

export function StudyBuddyProvider({ value, children }: { value: StudyBuddyActions; children: React.ReactNode }) {
  return <StudyBuddyContext.Provider value={value}>{children}</StudyBuddyContext.Provider>;
}

export function useStudyBuddyActions() {
  const ctx = useContext(StudyBuddyContext);
  if (!ctx) throw new Error("useStudyBuddyActions must be used within StudyBuddyProvider");
  return ctx;
}
