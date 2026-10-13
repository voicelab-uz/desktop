import { useTranslation } from "react-i18next";
import { CalendarPlus, NotebookPen, Play, X } from "lucide-react";

import type { IslandMeetingState } from "../../types/electron";

interface MeetingIslandCardProps {
  state: IslandMeetingState | null;
  onStart: () => void;
  onOpen: () => void;
  onConnectCalendar: () => void;
  onClose: () => void;
}

function minutesUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const start = Date.parse(iso);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.round((start - Date.now()) / 60000));
}

/**
 * The card the dictation island morphs into when the meeting-notes button is
 * pressed: what the next step is (start, or open the recording in progress),
 * the upcoming calendar meeting when one is near, and calendar connection.
 */
export default function MeetingIslandCard({
  state,
  onStart,
  onOpen,
  onConnectCalendar,
  onClose,
}: MeetingIslandCardProps) {
  const { t } = useTranslation();
  const recording = state?.recording === true;
  const nextEvent = state?.nextEvent ?? null;
  const startsIn = minutesUntil(nextEvent?.startTime);
  const showCalendarConnect = state !== null && !state.calendarConnected && !recording;

  const title = recording
    ? t("app.island.card.recordingTitle")
    : nextEvent && startsIn !== null
      ? startsIn === 0
        ? t("app.island.card.nowTitle", { title: nextEvent.summary })
        : t("app.island.card.upcomingTitle", { title: nextEvent.summary, minutes: startsIn })
      : t("app.island.card.title");
  const body = recording ? t("app.island.card.recordingBody") : t("app.island.card.body");

  return (
    <div className="meeting-island-card" role="dialog" aria-label={t("app.island.card.eyebrow")}>
      <div className="flex items-start gap-3">
        <span className="meeting-island-card__eyebrow">
          <NotebookPen className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
          {t("app.island.card.eyebrow")}
          {recording && <span className="meeting-island-card__live" aria-hidden="true" />}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="meeting-island-card__close"
          aria-label={t("common.close")}
        >
          <X className="size-4" strokeWidth={2.2} />
        </button>
      </div>
      <p className="meeting-island-card__title">{title}</p>
      <p className="meeting-island-card__body">{body}</p>
      <div className="meeting-island-card__actions">
        {showCalendarConnect ? (
          <button type="button" className="meeting-island-card__ghost" onClick={onConnectCalendar}>
            <CalendarPlus className="size-4" strokeWidth={2} aria-hidden="true" />
            {t("app.island.card.connectCalendar")}
          </button>
        ) : (
          <button type="button" className="meeting-island-card__ghost" onClick={onClose}>
            {t("app.island.card.notNow")}
          </button>
        )}
        <button
          type="button"
          className="meeting-island-card__primary"
          onClick={recording ? onOpen : onStart}
          autoFocus
        >
          {recording ? (
            <NotebookPen className="size-4" strokeWidth={2.2} aria-hidden="true" />
          ) : (
            <Play className="size-4 fill-current" strokeWidth={0} aria-hidden="true" />
          )}
          {recording ? t("app.island.card.open") : t("app.island.card.start")}
        </button>
      </div>
    </div>
  );
}
