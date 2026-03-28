import { create } from "zustand";
import type { Meeting, RecordingState, ProcessingStep } from "../types";

interface MeetingStore {
  // 상태
  recordingState: RecordingState;
  processingStep: ProcessingStep;
  audioLevel: number;
  currentMeeting: Meeting | null;
  meetings: Meeting[];
  error: string | null;

  // 액션
  setRecordingState: (state: RecordingState) => void;
  setProcessingStep: (step: ProcessingStep) => void;
  setAudioLevel: (level: number) => void;
  setCurrentMeeting: (meeting: Meeting | null) => void;
  setMeetings: (meetings: Meeting[]) => void;
  updateCurrentMeeting: (updates: Partial<Meeting>) => void;
  addMeeting: (meeting: Meeting) => void;
  removeMeeting: (id: string) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useMeetingStore = create<MeetingStore>((set) => ({
  recordingState: "idle",
  processingStep: null,
  audioLevel: 0,
  currentMeeting: null,
  meetings: [],
  error: null,

  setRecordingState: (state) => set({ recordingState: state }),
  setProcessingStep: (step) => set({ processingStep: step }),
  setAudioLevel: (level) => set({ audioLevel: level }),
  setCurrentMeeting: (meeting) => set({ currentMeeting: meeting }),
  setMeetings: (meetings) => set({ meetings }),

  updateCurrentMeeting: (updates) =>
    set((state) => ({
      currentMeeting: state.currentMeeting
        ? { ...state.currentMeeting, ...updates }
        : null,
    })),

  addMeeting: (meeting) =>
    set((state) => ({ meetings: [meeting, ...state.meetings] })),

  removeMeeting: (id) =>
    set((state) => ({
      meetings: state.meetings.filter((m) => m.id !== id),
    })),

  setError: (error) => set({ error }),

  reset: () =>
    set({
      recordingState: "idle",
      processingStep: null,
      audioLevel: 0,
      currentMeeting: null,
      error: null,
    }),
}));
