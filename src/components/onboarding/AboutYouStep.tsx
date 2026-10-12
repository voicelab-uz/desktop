import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Briefcase,
  Clapperboard,
  Code2,
  GraduationCap,
  Headphones,
  Megaphone,
  MoreHorizontal,
  Package,
  PenLine,
  Rocket,
  Scale,
  Settings2,
  Stethoscope,
  TrendingUp,
} from "lucide-react";
import { ChoiceGrid, StepFrame } from "./ui";
import { useSettingsStore } from "../../stores/settingsStore";

const ROLES = [
  { id: "developer", icon: Code2 },
  { id: "founder", icon: Rocket },
  { id: "product", icon: Package },
  { id: "marketing", icon: Megaphone },
  { id: "sales", icon: TrendingUp },
  { id: "operations", icon: Settings2 },
  { id: "student", icon: GraduationCap },
  { id: "educator", icon: BookOpen },
  { id: "writer", icon: PenLine },
  { id: "creator", icon: Clapperboard },
  { id: "consultant", icon: Briefcase },
  { id: "legal", icon: Scale },
  { id: "healthcare", icon: Stethoscope },
  { id: "support", icon: Headphones },
  { id: "other", icon: MoreHorizontal },
];

export default function AboutYouStep() {
  const { t } = useTranslation();
  const role = useSettingsStore((state) => state.onboardingRole);
  const setRole = useSettingsStore((state) => state.setOnboardingRole);

  return (
    <StepFrame
      title={t("desktop.onboarding.aboutYou.title")}
      description={t("desktop.onboarding.aboutYou.description")}
      width="lg"
    >
      <ChoiceGrid
        columns={4}
        compact
        value={role}
        onChange={(next) => setRole(next as string)}
        options={ROLES.map((item) => ({
          id: item.id,
          icon: item.icon,
          label: t(`desktop.onboarding.aboutYou.roles.${item.id}`),
        }))}
      />
    </StepFrame>
  );
}
