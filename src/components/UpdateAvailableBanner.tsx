import { useTranslation } from "react-i18next";
import { useUpdater } from "../hooks/useUpdater";
import { useToast } from "./ui/useToast";
import { Button } from "./ui/button";

// Update checking, downloading, and installing never require an account -
// none of the IPC handlers behind useUpdater() touch auth state. This banner
// exists so that fact is actually reachable: without it, a person stuck on
// the sign-in screen (an expired session, a network hiccup, anything) has no
// way to see or apply a pending update, even though nothing is stopping them
// from doing so. See the sign-in screen in AppRouter.jsx for where this is
// rendered - deliberately not shown during onboarding, where nudging a new
// user to update mid-setup would just be noise.
export default function UpdateAvailableBanner() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { status, downloadProgress, isDownloading, isInstalling, downloadUpdate, installUpdate } =
    useUpdater();

  const hasUpdate = !status.isDevelopment && (status.updateAvailable || status.updateDownloaded);
  if (!hasUpdate) return null;

  const handleClick = async () => {
    if (status.updateDownloaded) {
      try {
        await installUpdate();
      } catch {
        toast({
          title: t("controlPanel.update.couldNotInstallTitle"),
          description: t("controlPanel.update.couldNotInstallDescription"),
          variant: "destructive",
        });
      }
      return;
    }
    if (!isDownloading) {
      try {
        await downloadUpdate();
      } catch {
        toast({
          title: t("controlPanel.update.couldNotDownloadTitle"),
          description: t("controlPanel.update.couldNotDownloadDescription"),
          variant: "destructive",
        });
      }
    }
  };

  const label = isInstalling
    ? t("controlPanel.update.installing")
    : status.updateDownloaded
      ? t("controlPanel.update.installButton")
      : t("controlPanel.update.availableButton");

  return (
    <div className="w-full max-w-sm mx-auto mb-4">
      <Button
        variant="outline"
        className="h-11 w-full rounded-lg"
        disabled={isInstalling}
        onClick={() => void handleClick()}
      >
        {label}
      </Button>
      {isDownloading && !status.updateDownloaded && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-foreground/10">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${Math.min(Math.max(downloadProgress, 0), 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
