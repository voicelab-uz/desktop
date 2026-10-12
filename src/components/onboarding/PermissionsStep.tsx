import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check, Mic, TextCursorInput } from "lucide-react";
import { Card, OnbButton, StepFrame } from "./ui";
import type { UsePermissionsReturn } from "../../hooks/usePermissions";

interface PermissionsStepProps {
  permissions: UsePermissionsReturn;
  needsTextInsertionPermission: boolean;
  onReadyChange: (ready: boolean) => void;
}

export default function PermissionsStep({
  permissions,
  needsTextInsertionPermission,
  onReadyChange,
}: PermissionsStepProps) {
  const { t } = useTranslation();
  const rows = [
    {
      id: "microphone",
      icon: Mic,
      title: t("desktop.onboarding.permissions.microphoneTitle"),
      description: t("desktop.onboarding.permissions.microphoneDescription"),
      help: t("desktop.onboarding.permissions.microphoneHelp"),
      success: t("desktop.onboarding.permissions.microphoneSuccess"),
      granted: permissions.micPermissionGranted,
      request: permissions.requestMicPermission,
    },
    ...(needsTextInsertionPermission
      ? [
          {
            id: "accessibility",
            icon: TextCursorInput,
            title: t("desktop.onboarding.permissions.accessibilityTitle"),
            description: t("desktop.onboarding.permissions.accessibilityDescription"),
            help: t("desktop.onboarding.permissions.accessibilityHelp"),
            success: t("desktop.onboarding.permissions.accessibilitySuccess"),
            granted: permissions.accessibilityPermissionGranted,
            request: permissions.requestAccessibilityPermission,
          },
        ]
      : []),
  ];
  const allGranted = rows.every((row) => row.granted);

  useEffect(() => {
    onReadyChange(allGranted);
  }, [allGranted, onReadyChange]);

  return (
    <StepFrame
      title={
        allGranted
          ? t("desktop.onboarding.permissions.headerComplete")
          : t("desktop.onboarding.permissions.headerInProgress")
      }
      description={t("desktop.onboarding.permissions.description")}
      width="md"
    >
      <div className="onboarding-stagger flex w-full max-w-lg flex-col gap-2.5">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <Card
              key={row.id}
              className={`flex items-center gap-4 px-4 py-3.5 text-left transition-colors ${
                row.granted ? "border-[var(--onb-success)]/40" : ""
              }`}
            >
              <span
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors ${
                  row.granted
                    ? "bg-[var(--onb-success)] text-white"
                    : "bg-[var(--onb-panel)] text-[var(--onb-ink)]"
                }`}
              >
                {row.granted ? (
                  <Check className="h-5 w-5" strokeWidth={2.5} />
                ) : (
                  <Icon className="h-5 w-5" strokeWidth={1.7} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-5">{row.title}</p>
                <p className="mt-0.5 text-xs leading-5 text-[var(--onb-ink-muted)]">
                  {row.description}
                </p>
                <p
                  className={`mt-1 text-xs leading-4 ${
                    row.granted
                      ? "text-[var(--onb-success)]"
                      : "text-[var(--onb-ink-muted)] opacity-80"
                  }`}
                  role={row.granted ? "status" : undefined}
                >
                  {row.granted ? row.success : row.help}
                </p>
              </div>
              {!row.granted && (
                <OnbButton size="sm" className="shrink-0" onClick={row.request}>
                  {t("desktop.onboarding.permissions.allow")}
                </OnbButton>
              )}
            </Card>
          );
        })}
      </div>

      {!allGranted && (
        <p className="mt-4 text-xs leading-4 text-[var(--onb-ink-muted)]" role="status">
          {t("desktop.onboarding.permissions.notice")}
        </p>
      )}
    </StepFrame>
  );
}
