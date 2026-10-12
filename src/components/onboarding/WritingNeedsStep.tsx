import { useTranslation } from "react-i18next";
import {
  Bot,
  Code2,
  FileText,
  Footprints,
  HandMetal,
  Lightbulb,
  Mail,
  MessageSquare,
} from "lucide-react";
import { ChoiceGrid, StepFrame } from "./ui";
import { useSettingsStore } from "../../stores/settingsStore";

const NEEDS = [
  { id: "captureIdeas", icon: Lightbulb },
  { id: "draftDocuments", icon: FileText },
  { id: "manyEmails", icon: Mail },
  { id: "manyMessages", icon: MessageSquare },
  { id: "typingTiring", icon: HandMetal },
  { id: "handsFree", icon: Footprints },
  { id: "aiPrompts", icon: Bot },
  { id: "codeWithAi", icon: Code2 },
];

export default function WritingNeedsStep() {
  const { t } = useTranslation();
  const needs = useSettingsStore((state) => state.onboardingWritingNeeds);
  const setNeeds = useSettingsStore((state) => state.setOnboardingWritingNeeds);

  return (
    <StepFrame
      title={t("desktop.onboarding.writingNeeds.title")}
      description={t("desktop.onboarding.writingNeeds.description")}
      width="lg"
    >
      <ChoiceGrid
        multi
        columns={2}
        compact
        value={needs}
        onChange={(next) => setNeeds(next as string[])}
        className="max-w-2xl"
        options={NEEDS.map((item) => ({
          id: item.id,
          icon: item.icon,
          label: t(`desktop.onboarding.writingNeeds.options.${item.id}`),
        }))}
      />
    </StepFrame>
  );
}
