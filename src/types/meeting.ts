export type MeetingStatus = "recording" | "processing" | "ready" | "failed";

export interface ProviderConfig {
  provider: string;
  model: string;
  endpoint: string;
}

export interface Meeting {
  id: string;
  title: string;
  startedAt: string;
  durationSeconds: number | null;
  status: MeetingStatus;
  summary: string | null;
  audioPath: string | null;
}

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  startMs: number;
  endMs: number;
  speakerId: string | null;
  text: string;
  isEdited: boolean;
}

export interface Speaker {
  id: string;
  meetingId: string;
  label: string;
  displayName: string | null;
}

export interface ActionItem {
  id: string;
  meetingId: string;
  task: string;
  owner: string | null;
  dueDate: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "in_progress" | "complete";
  sourceStartMs: number | null;
}
