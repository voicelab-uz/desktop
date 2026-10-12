import {
  Bot,
  Code2,
  FileText,
  LucideIcon,
  Mail,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  NotebookPen,
} from "lucide-react";

export const USE_CASE_IDS = {
  messages: "messages",
  emails: "emails",
  documents: "documents",
  notes: "notes",
  ai: "ai",
  coding: "coding",
  posts: "posts",
  other: "other",
} as const;

export type UseCaseId = (typeof USE_CASE_IDS)[keyof typeof USE_CASE_IDS];

export interface UseCaseOption {
  id: UseCaseId;
  icon: LucideIcon;
}

export const USE_CASE_OPTIONS: UseCaseOption[] = [
  { id: USE_CASE_IDS.messages, icon: MessageSquare },
  { id: USE_CASE_IDS.emails, icon: Mail },
  { id: USE_CASE_IDS.documents, icon: FileText },
  { id: USE_CASE_IDS.notes, icon: NotebookPen },
  { id: USE_CASE_IDS.ai, icon: Bot },
  { id: USE_CASE_IDS.coding, icon: Code2 },
  { id: USE_CASE_IDS.posts, icon: MessagesSquare },
  { id: USE_CASE_IDS.other, icon: MoreHorizontal },
];
