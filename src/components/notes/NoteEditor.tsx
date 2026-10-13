import { useState, useRef, useEffect, useMemo, useCallback, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  Loader2,
  FileText,
  Sparkles,
  AlignLeft,
  MessageSquareText,
  Calendar,
  LinkIcon,
  Search,
  Plus,
  Check,
  Share2,
} from "lucide-react";
import ShareNoteDialog from "./ShareNoteDialog";
import { useShareCacheEntry } from "../../stores/noteStore";
import { SHARING_ENABLED } from "../../lib/features";
import { RichTextEditor } from "../ui/RichTextEditor";
import type { Editor } from "@tiptap/react";
import { MeetingTranscriptChat, SelectionBar } from "./MeetingTranscriptChat";
import {
  useMeetingRecordingStore,
  type TranscriptSegment,
} from "../../stores/meetingRecordingStore";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import type { NoteItem, FolderItem } from "../../types/electron";
import { displayFolderName } from "./shared";
import NoteBottomBar from "./NoteBottomBar";
import { normalizeDbDate } from "../../utils/dateFormatting";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";
import {
  applyTranscriptSpeakerPatch,
  lockTranscriptSpeaker,
  mergeTranscriptSegments,
  serializeTranscriptSegments,
} from "../../utils/transcriptSpeakerState";
import NoteParticipants from "./NoteParticipants";
import type { CalendarAttendee } from "../../types/calendar";
import VoiceLabIcon from "../ui/VoiceLabIcon";
import folderOpenIcon from "../../assets/icons/folder-open.svg";

function formatNoteDate(dateStr: string): string {
  const date = normalizeDbDate(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  const datePart = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart} \u00b7 ${timePart}`;
}

function formatShortDate(dateStr: string): string {
  const date = normalizeDbDate(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface Enhancement {
  content: string;
  isStale: boolean;
  onChange: (content: string) => void;
}

type MeetingViewMode = "raw" | "transcript" | "enhanced";

type SpeakerProfileOption = { id?: number; display_name: string; email: string | null };

function buildKnownSpeakers(
  profiles: SpeakerProfileOption[],
  segments: TranscriptSegment[],
  mappings: Record<string, string>
): SpeakerProfileOption[] {
  const seen = new Set<string>();
  const list: SpeakerProfileOption[] = [];
  for (const p of profiles) {
    const key = p.display_name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(p);
  }
  for (const segment of segments) {
    if (!segment.speaker) continue;
    const name = mappings[segment.speaker] || segment.speakerName;
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ display_name: name, email: null });
  }
  return list;
}

type LiveMeetingTranscriptChatProps = Omit<
  ComponentProps<typeof MeetingTranscriptChat>,
  | "segments"
  | "micPartial"
  | "systemPartial"
  | "systemPartialSpeakerId"
  | "systemPartialSpeakerName"
  | "isRecording"
>;

// Subscribes to live transcript state at this leaf so per-update re-renders
// don't reach the editor/chat (which would drop text selection).
function LiveMeetingTranscriptChat({
  speakerProfiles,
  speakerMappings,
  ...props
}: LiveMeetingTranscriptChatProps) {
  const segments = useMeetingRecordingStore((s) => s.segments);
  const micPartial = useMeetingRecordingStore((s) => s.micPartial);
  const systemPartial = useMeetingRecordingStore((s) => s.systemPartial);
  const systemPartialSpeakerId = useMeetingRecordingStore((s) => s.systemPartialSpeakerId);
  const systemPartialSpeakerName = useMeetingRecordingStore((s) => s.systemPartialSpeakerName);

  const knownSpeakers = useMemo(
    () => buildKnownSpeakers(speakerProfiles ?? [], segments, speakerMappings ?? {}),
    [segments, speakerMappings, speakerProfiles]
  );

  return (
    <MeetingTranscriptChat
      {...props}
      isRecording
      segments={segments}
      micPartial={micPartial}
      systemPartial={systemPartial}
      systemPartialSpeakerId={systemPartialSpeakerId}
      systemPartialSpeakerName={systemPartialSpeakerName}
      speakerMappings={speakerMappings}
      speakerProfiles={knownSpeakers}
    />
  );
}

interface NoteEditorProps {
  note: NoteItem;
  onTitleChange: (title: string) => void;
  onContentChange: (content: string) => void;
  isSaving: boolean;
  isRecording: boolean;
  isProcessing: boolean;
  onStartRecording: () => void;
  onStartMeetingRecording?: () => void;
  onStopRecording: () => void;
  onExportNote?: (format: "md" | "txt") => void;
  onExportTranscript?: (format: "txt" | "srt" | "json" | "md") => void;
  enhancement?: Enhancement;
  diarizationSessionId?: string | null;
  onLiveSpeakerLock?: (speakerId: string, displayName: string) => void;
  sessionDiarizationEnabled?: boolean;
  sessionExpectedCount?: number;
  userTouchedStepper?: boolean;
  onSetSessionDiarizationEnabled?: (enabled: boolean) => void;
  onSetSessionExpectedCount?: (count: number) => void;
  folderName?: string | null;
  calendarEventName?: string | null;
  folders?: FolderItem[];
  onMoveToFolder?: (noteId: number, folderId: number) => void;
  onCreateFolderAndMove?: (noteId: number, folderName: string) => void;
}

export default function NoteEditor({
  note,
  onTitleChange,
  onContentChange,
  isSaving,
  isRecording,
  isProcessing,
  onStartRecording,
  onStartMeetingRecording,
  onStopRecording,
  onExportNote,
  onExportTranscript,
  enhancement,
  diarizationSessionId,
  onLiveSpeakerLock,
  sessionDiarizationEnabled,
  sessionExpectedCount,
  userTouchedStepper,
  onSetSessionDiarizationEnabled,
  onSetSessionExpectedCount,
  folderName,
  calendarEventName,
  folders,
  onMoveToFolder,
  onCreateFolderAndMove,
}: NoteEditorProps) {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<MeetingViewMode>("raw");
  const [folderSearch, setFolderSearch] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isDiarizing, setIsDiarizing] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const shareCache = useShareCacheEntry(note.cloud_id);
  const isShared = (shareCache?.share.visibility ?? "private") !== "private";
  const [diarizedSegments, setDiarizedSegments] = useState<TranscriptSegment[] | null>(null);
  const [speakerMappings, setSpeakerMappings] = useState<Record<string, string>>({});
  const [speakerProfiles, setSpeakerProfiles] = useState<
    Array<{ id: number; display_name: string; email: string | null }>
  >([]);
  const editorRef = useRef<Editor | null>(null);
  const recordingMode = useMeetingRecordingStore((s) => s.recordingMode);
  const isDictating = isRecording && recordingMode === "dictation";
  const isMeetingRecording = isRecording && !isDictating;
  const displaySegmentsRef = useRef<TranscriptSegment[]>([]);

  const titleRef = useRef<HTMLDivElement>(null);
  const prevNoteIdRef = useRef<number>(note.id);

  const segmentContainerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({ opacity: 0 });
  const scheduleUiUpdate = useCallback((callback: () => void) => {
    const frameId = window.requestAnimationFrame(callback);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  const hasMeetingTranscript = !!note.transcript;

  const filteredFolders = useMemo(
    () =>
      folderSearch && folders
        ? folders.filter((f) => f.name.toLowerCase().includes(folderSearch.toLowerCase()))
        : (folders ?? []),
    [folders, folderSearch]
  );

  const displaySegments = useMemo<TranscriptSegment[]>(() => {
    if (diarizedSegments && diarizedSegments.length > 0) return diarizedSegments;
    return parseTranscriptSegments(note.transcript || "");
  }, [diarizedSegments, note.transcript]);

  useEffect(() => {
    displaySegmentsRef.current = displaySegments;
  }, [displaySegments]);

  const hasChatSegments = displaySegments.length > 0;

  const knownSpeakers = useMemo(
    () => buildKnownSpeakers(speakerProfiles, displaySegments, speakerMappings),
    [displaySegments, speakerMappings, speakerProfiles]
  );

  const parsedParticipants = useMemo<CalendarAttendee[]>(() => {
    try {
      return note.participants ? JSON.parse(note.participants) : [];
    } catch {
      return [];
    }
  }, [note.participants]);

  const refreshSpeakerProfiles = useCallback(() => {
    window.electronAPI?.getSpeakerProfiles?.().then((profiles) => {
      setSpeakerProfiles(
        (profiles || []).map((profile) => ({
          id: profile.id,
          display_name: profile.display_name,
          email: profile.email,
        }))
      );
    });
  }, []);

  const updateSegmentIndicator = useCallback(() => {
    const container = segmentContainerRef.current;
    if (!container) return;

    const buttons = container.querySelectorAll<HTMLButtonElement>("[data-segment-button]");
    const activeBtn = Array.from(buttons).find((btn) => btn.dataset.segmentValue === viewMode);
    if (!activeBtn) return;

    const cr = container.getBoundingClientRect();
    const br = activeBtn.getBoundingClientRect();
    setIndicatorStyle({
      width: br.width,
      height: br.height,
      transform: `translateX(${br.left - cr.left}px)`,
      opacity: 1,
    });
  }, [viewMode]);

  useEffect(() => {
    updateSegmentIndicator();
  }, [updateSegmentIndicator]);

  useEffect(() => {
    const observer = new ResizeObserver(() => updateSegmentIndicator());
    if (segmentContainerRef.current) observer.observe(segmentContainerRef.current);
    return () => observer.disconnect();
  }, [updateSegmentIndicator]);

  useEffect(() => {
    if (note.id !== prevNoteIdRef.current) {
      prevNoteIdRef.current = note.id;
      return scheduleUiUpdate(() => {
        setDiarizedSegments(null);
        setIsDiarizing(false);
        setSpeakerMappings({});
        if (!isRecording) {
          setViewMode("raw");
        }
        if (titleRef.current && titleRef.current.textContent !== note.title) {
          titleRef.current.textContent = note.title || "";
        }
        editorRef.current?.commands.focus();
      });
    }
  }, [isRecording, note.id, note.title, scheduleUiUpdate]);

  useEffect(() => {
    window.electronAPI?.getSpeakerMappings?.(note.id).then((mappings) => {
      const map: Record<string, string> = {};
      for (const m of mappings || []) map[m.speaker_id] = m.display_name;
      setSpeakerMappings(map);
    });
    refreshSpeakerProfiles();
  }, [note.id, refreshSpeakerProfiles]);

  useEffect(() => {
    if (titleRef.current && titleRef.current.textContent !== note.title) {
      titleRef.current.textContent = note.title || "";
    }
  }, [note.title]);

  const prevRecordingForDiarizationRef = useRef(false);
  useEffect(() => {
    if (prevRecordingForDiarizationRef.current && !isRecording && diarizationSessionId) {
      const cancelScheduledUpdate = scheduleUiUpdate(() => setIsDiarizing(true));
      prevRecordingForDiarizationRef.current = isRecording;
      return cancelScheduledUpdate;
    }
    prevRecordingForDiarizationRef.current = isRecording;
  }, [diarizationSessionId, isRecording, scheduleUiUpdate]);

  useEffect(() => {
    const expectedSession = diarizationSessionId;
    const cleanup = window.electronAPI?.onMeetingDiarizationComplete?.(async (data) => {
      if (!expectedSession || data?.sessionId !== expectedSession) return;

      setIsDiarizing(false);

      if (!data?.segments?.length) return;

      // Store segments outlive their recording — only use them for the note they belong to.
      const { recordingNoteId, segments: liveSegments } = useMeetingRecordingStore.getState();
      const persisted = await window.electronAPI?.getNote?.(note.id);
      const existing = persisted?.transcript
        ? parseTranscriptSegments(persisted.transcript)
        : recordingNoteId === note.id && liveSegments.length > 0
          ? liveSegments
          : displaySegmentsRef.current;

      const enriched = mergeTranscriptSegments(
        existing,
        data.segments.map((s: any, i: number) => ({
          ...s,
          id: s.id || `diarized-${i}`,
        }))
      );
      setDiarizedSegments(enriched);

      window.electronAPI.updateNote(note.id, { transcript: serializeTranscriptSegments(enriched) });

      if (data.speakerEmbeddings) {
        window.electronAPI?.saveNoteSpeakerEmbeddings?.(note.id, data.speakerEmbeddings);
      }

      const autoMappings: Record<string, string> = {};
      for (const s of enriched) {
        if (s.speakerName && s.speaker) autoMappings[s.speaker] = s.speakerName;
      }
      if (Object.keys(autoMappings).length > 0) {
        setSpeakerMappings((prev) => ({ ...autoMappings, ...prev }));
      }
    });
    return () => cleanup?.();
  }, [note.id, diarizationSessionId]);

  const persistDisplaySegments = useCallback(
    async (nextSegments: TranscriptSegment[], updateOverlay = true) => {
      if (updateOverlay) {
        setDiarizedSegments(nextSegments);
      }
      await window.electronAPI?.updateNote(note.id, {
        transcript: serializeTranscriptSegments(nextSegments),
      });
    },
    [note.id]
  );

  const handleMapSpeaker = useCallback(
    async (
      speakerId: string,
      displayName: string,
      email?: string | null,
      profileId?: number | null
    ) => {
      setSpeakerMappings((prev) => ({ ...prev, [speakerId]: displayName }));
      await window.electronAPI?.setSpeakerMapping?.(
        note.id,
        speakerId,
        displayName,
        email,
        profileId
      );

      if (isRecording) {
        onLiveSpeakerLock?.(speakerId, displayName);
        refreshSpeakerProfiles();
        return;
      }

      const currentSegments = displaySegments.map((s) =>
        s.speaker === speakerId
          ? lockTranscriptSpeaker(s, {
              speakerName: displayName,
              speaker: speakerId,
              speakerIsPlaceholder: false,
              suggestedName: undefined,
              suggestedProfileId: undefined,
            })
          : s
      );
      await persistDisplaySegments(currentSegments, !!diarizedSegments || !isRecording);

      refreshSpeakerProfiles();
    },
    [
      diarizedSegments,
      displaySegments,
      isRecording,
      note.id,
      onLiveSpeakerLock,
      persistDisplaySegments,
      refreshSpeakerProfiles,
    ]
  );

  const handleConfirmSuggestion = useCallback(
    async (speakerId: string, suggestedName: string, profileId: number) => {
      await handleMapSpeaker(speakerId, suggestedName, null, profileId);
    },
    [handleMapSpeaker]
  );

  const handleAttachSpeakerEmail = useCallback(
    async (profileId: number, email: string | null) => {
      const result = await window.electronAPI?.attachSpeakerEmail?.(profileId, email);
      if (result?.success) {
        refreshSpeakerProfiles();
      }
    },
    [refreshSpeakerProfiles]
  );

  const handleDismissSuggestion = useCallback(
    async (speakerId: string) => {
      const currentSegments = displaySegments.map((s) =>
        s.speaker === speakerId
          ? applyTranscriptSpeakerPatch(s, {
              suggestedName: undefined,
              suggestedProfileId: undefined,
            })
          : s
      );
      await persistDisplaySegments(currentSegments, !!diarizedSegments || !isRecording);
    },
    [displaySegments, diarizedSegments, isRecording, persistDisplaySegments]
  );

  const [selectedSegmentIds, setSelectedSegmentIds] = useState<Set<string>>(new Set());
  const [selectionNoteId, setSelectionNoteId] = useState(note.id);
  if (selectionNoteId !== note.id) {
    setSelectionNoteId(note.id);
    setSelectedSegmentIds(new Set());
  }

  const handleToggleSelect = useCallback((segmentId: string) => {
    setSelectedSegmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(segmentId)) next.delete(segmentId);
      else next.add(segmentId);
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedSegmentIds(new Set());
  }, []);

  useEffect(() => {
    if (selectedSegmentIds.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedSegmentIds.size, handleClearSelection]);

  const handleBulkAssignName = useCallback(
    async (displayName: string, _email?: string | null, profileId?: number) => {
      if (!selectedSegmentIds.size) return;
      const nextSegments = displaySegments.map((segment) =>
        selectedSegmentIds.has(segment.id)
          ? lockTranscriptSpeaker(segment, {
              speakerName: displayName,
              speakerIsPlaceholder: false,
              suggestedName: undefined,
              suggestedProfileId: profileId ?? undefined,
            })
          : segment
      );
      await persistDisplaySegments(nextSegments);
      handleClearSelection();
    },
    [displaySegments, selectedSegmentIds, persistDisplaySegments, handleClearSelection]
  );

  const handleTitleInput = useCallback(() => {
    if (titleRef.current) {
      const text = titleRef.current.textContent || "";
      onTitleChange(text);
    }
  }, [onTitleChange]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      editorRef.current?.commands.focus();
    }
  }, []);

  const handleTitlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").replace(/\n/g, " ");
    document.execCommand("insertText", false, text);
  }, []);

  const prevRecordingRef = useRef(false);
  useEffect(() => {
    if (isMeetingRecording && !prevRecordingRef.current) {
      scheduleUiUpdate(() => setViewMode("transcript"));
    }
    prevRecordingRef.current = isMeetingRecording;
  }, [isMeetingRecording, scheduleUiUpdate]);

  // Voice typing: each phrase the server finishes is appended to the end of
  // the note without moving the person's cursor. Words are revealed one by one
  // so the note reads as if it is being typed while the person speaks, and
  // phrases are tracked by id so a store update never inserts text twice.
  const dictatedSegmentIdsRef = useRef<Set<string>>(new Set());
  const dictationQueueRef = useRef<string[]>([]);
  const dictationTimerRef = useRef<number | null>(null);
  const appendDictatedText = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || !text) return;
    const existing = editor.getText();
    const separator = existing && !/\s$/.test(existing) ? " " : "";
    // Continue the last paragraph instead of starting a new block for each
    // phrase, and leave the person's selection where it is.
    const { doc } = editor.state;
    const lastBlock = doc.lastChild;
    const position = lastBlock?.isTextblock ? doc.content.size - 1 : doc.content.size;
    editor.commands.insertContentAt(position, separator + text, { updateSelection: false });
  }, []);
  const flushDictationQueue = useCallback(() => {
    if (dictationTimerRef.current !== null) {
      window.clearTimeout(dictationTimerRef.current);
      dictationTimerRef.current = null;
    }
    const rest = dictationQueueRef.current.join(" ");
    dictationQueueRef.current = [];
    appendDictatedText(rest);
  }, [appendDictatedText]);
  const pumpDictationQueue = useCallback(() => {
    if (dictationTimerRef.current !== null) return;
    const step = () => {
      const word = dictationQueueRef.current.shift();
      if (word === undefined) {
        dictationTimerRef.current = null;
        return;
      }
      appendDictatedText(word);
      // Faster when a backlog builds up, so the note never trails far behind.
      const backlog = dictationQueueRef.current.length;
      const delay = backlog > 12 ? 18 : backlog > 6 ? 30 : 48;
      dictationTimerRef.current = window.setTimeout(step, delay);
    };
    step();
  }, [appendDictatedText]);
  useEffect(() => {
    if (!isDictating) {
      dictatedSegmentIdsRef.current = new Set();
      flushDictationQueue();
      return undefined;
    }
    dictatedSegmentIdsRef.current = new Set(
      useMeetingRecordingStore.getState().segments.map((segment) => segment.id)
    );
    const unsubscribe = useMeetingRecordingStore.subscribe((state) => {
      if (state.recordingNoteId !== note.id) return;
      for (const segment of state.segments) {
        if (segment.source !== "mic" || dictatedSegmentIdsRef.current.has(segment.id)) continue;
        dictatedSegmentIdsRef.current.add(segment.id);
        const words = segment.text.trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) continue;
        dictationQueueRef.current.push(...words);
        pumpDictationQueue();
      }
    });
    return () => {
      unsubscribe();
      flushDictationQueue();
    };
  }, [isDictating, note.id, flushDictationQueue, pumpDictationQueue]);

  const handleContentChange = useCallback(
    (newValue: string) => {
      onContentChange(newValue);
    },
    [onContentChange]
  );

  const handleEnhancedChange = useCallback(
    (value: string) => {
      enhancement?.onChange(value);
    },
    [enhancement]
  );

  const noteDate = formatNoteDate(note.created_at);
  const shortDate = formatShortDate(note.created_at);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="px-5 pt-4 pb-0">
          <div
            ref={titleRef}
            contentEditable
            suppressContentEditableWarning
            onInput={handleTitleInput}
            onKeyDown={handleTitleKeyDown}
            onPaste={handleTitlePaste}
            data-placeholder={t("notes.editor.untitled")}
            className="text-base font-semibold text-foreground bg-transparent outline-none tracking-tight empty:before:content-[attr(data-placeholder)] empty:before:text-foreground/15 empty:before:pointer-events-none"
            role="textbox"
            aria-label={t("notes.editor.noteTitle")}
          />
          <div className="flex items-center gap-2 mt-1.5">
            {shortDate && (
              <span
                className="inline-flex items-center gap-1.5 text-2xs text-foreground/50 dark:text-foreground/35"
                title={noteDate}
              >
                <Calendar size={11} className="shrink-0" />
                {shortDate}
              </span>
            )}
            {calendarEventName && (
              <span className="inline-flex items-center gap-1.5 text-2xs text-foreground/50 dark:text-foreground/35">
                <LinkIcon size={11} className="shrink-0" />
                <span className="truncate max-w-40">{calendarEventName}</span>
              </span>
            )}
            <NoteParticipants noteId={note.id} participants={parsedParticipants} />
            {folders && onMoveToFolder && (
              <DropdownMenu
                onOpenChange={(open) => {
                  if (!open) {
                    setFolderSearch("");
                    setIsCreatingFolder(false);
                    setNewFolderName("");
                  }
                }}
              >
                <DropdownMenuTrigger asChild>
                  <button className="inline-flex items-center gap-1.5 text-2xs px-1.5 py-0.5 rounded-md border border-border/70 dark:border-white/25 text-foreground/50 dark:text-foreground/35 hover:text-foreground/60 hover:border-border/60 hover:bg-foreground/3 dark:hover:text-foreground/40 dark:hover:border-white/10 dark:hover:bg-white/3 transition-all duration-150 cursor-pointer outline-none">
                    <VoiceLabIcon source={folderOpenIcon} className="size-[11px] shrink-0" />
                    {folderName ? displayFolderName(folderName, t) : t("notes.editor.noFolder")}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={6} className="min-w-44 p-1">
                  {folders.length > 5 && (
                    <>
                      <div className="relative px-1.5 py-0.5">
                        <Search
                          size={9}
                          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground/15 pointer-events-none"
                        />
                        <input
                          value={folderSearch}
                          onChange={(e) => setFolderSearch(e.target.value)}
                          onKeyDown={(e) => e.stopPropagation()}
                          placeholder={t("notes.context.searchFolders")}
                          className="input-inline w-full pl-4.5 pr-1 py-0.5 text-xs text-foreground placeholder:text-foreground/15 outline-none border-none appearance-none"
                        />
                      </div>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <div className="overflow-y-auto max-h-48">
                    {filteredFolders.map((folder) => {
                      const isCurrent = folder.id === note.folder_id;
                      return (
                        <DropdownMenuItem
                          key={folder.id}
                          disabled={isCurrent}
                          onClick={() => onMoveToFolder(note.id, folder.id)}
                          className="text-xs gap-2 rounded-md px-2 py-1.5"
                        >
                          <VoiceLabIcon
                            source={folderOpenIcon}
                            className="size-[11px] shrink-0 text-foreground/30"
                          />
                          <span className="truncate flex-1">
                            {displayFolderName(folder.name, t)}
                          </span>
                          {isCurrent && <Check size={9} className="text-primary shrink-0" />}
                        </DropdownMenuItem>
                      );
                    })}
                    {folderSearch && filteredFolders.length === 0 && (
                      <p className="text-xs text-foreground/20 text-center py-1.5">
                        {t("notes.context.noResults")}
                      </p>
                    )}
                  </div>
                  {onCreateFolderAndMove && (
                    <>
                      <DropdownMenuSeparator />
                      {isCreatingFolder ? (
                        <div className="px-1">
                          <input
                            autoFocus
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Enter" && newFolderName.trim()) {
                                onCreateFolderAndMove(note.id, newFolderName.trim());
                                setNewFolderName("");
                                setIsCreatingFolder(false);
                              }
                              if (e.key === "Escape") {
                                setIsCreatingFolder(false);
                                setNewFolderName("");
                              }
                            }}
                            placeholder={t("notes.folders.folderName")}
                            className="input-inline w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground placeholder:text-foreground/20 outline-none border-none appearance-none"
                          />
                        </div>
                      ) : (
                        <DropdownMenuItem
                          onSelect={(e) => {
                            e.preventDefault();
                            setIsCreatingFolder(true);
                          }}
                          className="text-xs gap-2 rounded-md px-2 py-1.5 text-foreground/40"
                        >
                          <Plus size={10} />
                          {t("notes.context.newFolder")}
                        </DropdownMenuItem>
                      )}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {isSaving && (
              <span className="inline-flex items-center gap-1 text-2xs text-foreground/30 dark:text-foreground/15 tabular-nums">
                <Loader2 size={8} className="animate-spin" />
                {t("notes.editor.saving")}
              </span>
            )}
            <div className="flex-1" />
            <div className="flex items-center gap-1">
              {(enhancement || hasMeetingTranscript || hasChatSegments || isMeetingRecording) && (
                <div
                  ref={segmentContainerRef}
                  className="relative flex items-center shrink-0 rounded-md bg-foreground/3 dark:bg-white/3 p-0.5"
                >
                  <div
                    className="absolute top-0.5 left-0 rounded bg-background dark:bg-surface-2 shadow-sm transition-[width,height,transform,opacity] duration-200 ease-out pointer-events-none"
                    style={indicatorStyle}
                  />
                  {(hasMeetingTranscript || hasChatSegments || isMeetingRecording) && (
                    <button
                      data-segment-button
                      data-segment-value="transcript"
                      onClick={() => setViewMode("transcript")}
                      className={cn(
                        "relative z-1 px-1.5 h-5 rounded text-xs font-medium transition-colors duration-150 flex items-center gap-1",
                        viewMode === "transcript"
                          ? "text-foreground/60"
                          : "text-foreground/25 hover:text-foreground/40"
                      )}
                    >
                      <MessageSquareText size={10} />
                      {t("notes.editor.transcript")}
                    </button>
                  )}
                  <button
                    data-segment-button
                    data-segment-value="raw"
                    onClick={() => setViewMode("raw")}
                    className={cn(
                      "relative z-1 px-1.5 h-5 rounded text-xs font-medium transition-colors duration-150 flex items-center gap-1",
                      viewMode === "raw"
                        ? "text-foreground/60"
                        : "text-foreground/25 hover:text-foreground/40"
                    )}
                  >
                    <AlignLeft size={10} />
                    {t("notes.editor.notes")}
                  </button>
                  {enhancement && (
                    <button
                      data-segment-button
                      data-segment-value="enhanced"
                      onClick={() => setViewMode("enhanced")}
                      className={cn(
                        "relative z-1 px-1.5 h-5 rounded text-xs font-medium transition-colors duration-150 flex items-center gap-1",
                        viewMode === "enhanced"
                          ? "text-foreground/60"
                          : "text-foreground/25 hover:text-foreground/40"
                      )}
                    >
                      <Sparkles size={9} />
                      {t("notes.editor.enhanced")}
                      {enhancement.isStale && (
                        <span
                          className="w-1 h-1 rounded-full bg-amber-400/60"
                          title={t("notes.editor.staleIndicator")}
                        />
                      )}
                    </button>
                  )}
                </div>
              )}
              {SHARING_ENABLED && note.cloud_id && (
                <button
                  type="button"
                  onClick={() => setShareDialogOpen(true)}
                  className={cn(
                    "shrink-0 h-6 w-6 flex items-center justify-center rounded-md",
                    "bg-foreground/4 dark:bg-white/5",
                    "hover:bg-foreground/8 dark:hover:bg-white/10",
                    "active:bg-foreground/12 dark:active:bg-white/15",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    "transition-colors duration-150"
                  )}
                  aria-label={t("noteEditor.share.button")}
                >
                  <Share2
                    size={11}
                    className={cn(
                      "transition-colors",
                      isShared
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-foreground/50 dark:text-foreground/40"
                    )}
                  />
                </button>
              )}
              {(onExportNote || onExportTranscript) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="shrink-0 h-6 w-6 flex items-center justify-center rounded-md bg-foreground/4 dark:bg-white/5 text-foreground/50 dark:text-foreground/40 hover:text-foreground/70 hover:bg-foreground/8 dark:hover:text-foreground/60 dark:hover:bg-white/8 transition-colors duration-150"
                      aria-label={t("notes.editor.export")}
                    >
                      <Download size={11} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={4}>
                    {viewMode === "transcript" && onExportTranscript ? (
                      <>
                        <DropdownMenuItem
                          onClick={() => onExportTranscript("txt")}
                          className="text-xs gap-2"
                        >
                          <FileText size={13} className="text-foreground/40" />
                          {t("notes.editor.asTranscriptText")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => onExportTranscript("srt")}
                          className="text-xs gap-2"
                        >
                          <FileText size={13} className="text-foreground/40" />
                          {t("notes.editor.asSubtitles")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => onExportTranscript("md")}
                          className="text-xs gap-2"
                        >
                          <FileText size={13} className="text-foreground/40" />
                          {t("notes.editor.asTranscriptMarkdown")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => onExportTranscript("json")}
                          className="text-xs gap-2"
                        >
                          <FileText size={13} className="text-foreground/40" />
                          {t("notes.editor.asJson")}
                        </DropdownMenuItem>
                      </>
                    ) : (
                      <>
                        <DropdownMenuItem
                          onClick={() => onExportNote?.("md")}
                          className="text-xs gap-2"
                        >
                          <FileText size={13} className="text-foreground/40" />
                          {t("notes.editor.asMarkdown")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => onExportNote?.("txt")}
                          className="text-xs gap-2"
                        >
                          <FileText size={13} className="text-foreground/40" />
                          {t("notes.editor.asPlainText")}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 relative min-h-0">
          <div className="h-full overflow-y-auto">
            {viewMode === "transcript" && (hasChatSegments || isMeetingRecording) ? (
              isMeetingRecording ? (
                <LiveMeetingTranscriptChat
                  speakerMappings={speakerMappings}
                  speakerProfiles={speakerProfiles}
                  participants={parsedParticipants}
                  isDiarizing={isDiarizing}
                  sessionDiarizationEnabled={sessionDiarizationEnabled}
                  sessionExpectedCount={sessionExpectedCount}
                  userTouchedStepper={userTouchedStepper}
                  onSetSessionDiarizationEnabled={onSetSessionDiarizationEnabled}
                  onSetSessionExpectedCount={onSetSessionExpectedCount}
                  onMapSpeaker={handleMapSpeaker}
                  onConfirmSuggestion={handleConfirmSuggestion}
                  onDismissSuggestion={handleDismissSuggestion}
                  onAttachSpeakerEmail={handleAttachSpeakerEmail}
                />
              ) : (
                <MeetingTranscriptChat
                  segments={displaySegments}
                  speakerMappings={speakerMappings}
                  speakerProfiles={knownSpeakers}
                  participants={parsedParticipants}
                  isDiarizing={isDiarizing}
                  sessionDiarizationEnabled={sessionDiarizationEnabled}
                  sessionExpectedCount={sessionExpectedCount}
                  userTouchedStepper={userTouchedStepper}
                  onSetSessionDiarizationEnabled={onSetSessionDiarizationEnabled}
                  onSetSessionExpectedCount={onSetSessionExpectedCount}
                  onMapSpeaker={handleMapSpeaker}
                  onConfirmSuggestion={handleConfirmSuggestion}
                  onDismissSuggestion={handleDismissSuggestion}
                  onAttachSpeakerEmail={handleAttachSpeakerEmail}
                  selectedSegmentIds={selectedSegmentIds}
                  onToggleSelect={handleToggleSelect}
                />
              )
            ) : viewMode === "transcript" && hasMeetingTranscript ? (
              <RichTextEditor value={note.transcript || ""} disabled />
            ) : viewMode === "enhanced" && enhancement ? (
              <RichTextEditor value={enhancement.content} onChange={handleEnhancedChange} />
            ) : (
              <div className={isDictating ? "note-dictating" : undefined}>
                <RichTextEditor
                  value={note.content}
                  onChange={handleContentChange}
                  editorRef={editorRef}
                  placeholder={t("notes.editor.startWriting")}
                />
              </div>
            )}
          </div>
          <div
            className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none"
            style={{
              background: "linear-gradient(to bottom, transparent, var(--color-background))",
            }}
          />
          {!isRecording && selectedSegmentIds.size > 0 && (
            <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
              <SelectionBar
                count={selectedSegmentIds.size}
                onClear={handleClearSelection}
                speakerProfiles={knownSpeakers}
                participants={parsedParticipants}
                onAssignName={handleBulkAssignName}
                t={t}
              />
            </div>
          )}
          <NoteBottomBar
            isRecording={isRecording}
            isDictating={isDictating}
            isProcessing={isProcessing}
            onStartRecording={onStartRecording}
            onStartMeetingRecording={onStartMeetingRecording}
            onStopRecording={onStopRecording}
          />
        </div>
      </div>
      {SHARING_ENABLED && note.cloud_id && (
        <ShareNoteDialog open={shareDialogOpen} onOpenChange={setShareDialogOpen} note={note} />
      )}
    </div>
  );
}
