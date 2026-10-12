import { TFunction } from "i18next";
import i18next from "i18next";

type RecordingError = {
  code?: string;
  title: string;
  description?: string;
  messageKey?: string;
  retryAfterSeconds?: number;
  max_duration_seconds?: number;
  requestId?: string | null;
  serverCode?: string | null;
};

type RecoveryCopy = { title: string; description: string };
export type RecordingRecoveryAction = "auth" | "billing" | "permission" | "retry" | null;

const COPY: Record<string, Record<string, RecoveryCopy>> = {
  en: {
    INSUFFICIENT_CREDITS: {
      title: "More AI Credits needed",
      description: "Add credits or choose a plan, then try again.",
    },
    ENTITLEMENT_REQUIRED: {
      title: "Flow is not included",
      description: "Open billing to choose a plan that includes VoiceLab Flow.",
    },
    AUTH_EXPIRED: {
      title: "Sign in again",
      description: "Your session ended. Sign in again to continue with VoiceLab Cloud.",
    },
    AUTH_REQUIRED: {
      title: "Sign in to continue",
      description: "Connect your VoiceLab account to start dictating.",
    },
    DEVICE_LIMIT: {
      title: "Too many connected devices",
      description: "Remove a device from your account, then try again.",
    },
    CONCURRENCY_LIMIT: {
      title: "Another recording is being processed",
      description: "Wait for it to finish, then try again.",
    },
    DAILY_CAP_REACHED: {
      title: "Today’s cloud allowance is used",
      description: "Try again tomorrow or manage your VoiceLab plan.",
    },
    RATE_LIMITED: {
      title: "Please wait a moment",
      description: "VoiceLab received several requests at once. Try again shortly.",
    },
    AUDIO_LIMIT_EXCEEDED: {
      title: "Recording limit exceeded",
      description: "Use a recording under 300 seconds and 200 MiB.",
    },
    AUDIO_INVALID: {
      title: "Audio could not be processed",
      description: "Check the recording and try again.",
    },
    AUDIO_LANGUAGE_UNSUPPORTED: {
      title: "Language is not supported",
      description: "Choose Uzbek, English, or Russian and make a new recording.",
    },
    NO_SPEECH_DETECTED: {
      title: "No speech detected",
      description: "Speak clearly and make a new recording.",
    },
    INVALID_REQUEST: {
      title: "Recording request is invalid",
      description: "Make a new recording and try again.",
    },
    IDEMPOTENCY_CONFLICT: {
      title: "This recording could not be resumed",
      description: "Start a new recording and try again.",
    },
    SERVICE_UNAVAILABLE: {
      title: "VoiceLab is temporarily unavailable",
      description:
        "Your recording is kept on this device. Retry only when you want to send it again.",
    },
    PASTE_ACCESSIBILITY_REQUIRED: {
      title: "Permission needed for automatic paste",
      description:
        "The text was copied to your clipboard. Enable VoiceLab in System Settings → Privacy & Security → Accessibility, then paste again.",
    },
  },
  uz: {
    INSUFFICIENT_CREDITS: {
      title: "Ko‘proq AI Credit kerak",
      description: "Credit qo‘shing yoki mos VoiceLab tarifini tanlang.",
    },
    ENTITLEMENT_REQUIRED: {
      title: "Flow tarifga kirmagan",
      description: "VoiceLab Flow bor tarifni billing sahifasidan tanlang.",
    },
    AUTH_EXPIRED: {
      title: "Qayta kiring",
      description: "Sessiya tugadi. VoiceLab Cloud’dan foydalanish uchun qayta kiring.",
    },
    AUTH_REQUIRED: {
      title: "Davom etish uchun kiring",
      description: "VoiceLab hisobingizga kiring.",
    },
    DEVICE_LIMIT: {
      title: "Ulangan qurilmalar ko‘p",
      description: "Hisobdan eski qurilmani olib tashlab, qayta urinib ko‘ring.",
    },
    CONCURRENCY_LIMIT: {
      title: "Boshqa yozuv qayta ishlanmoqda",
      description: "U tugagach yana urinib ko‘ring.",
    },
    DAILY_CAP_REACHED: {
      title: "Bugungi cloud limiti tugadi",
      description: "Ertaga qayta urinib ko‘ring yoki VoiceLab tarifingizni boshqaring.",
    },
    RATE_LIMITED: {
      title: "Biroz kuting",
      description: "Bir vaqtda ko‘p so‘rov yuborildi. Sal o‘tib yana urinib ko‘ring.",
    },
    AUDIO_LIMIT_EXCEEDED: {
      title: "Yozuv limitdan oshdi",
      description: "Yozuv 300 soniya va 200 MiB’dan oshmasin.",
    },
    AUDIO_INVALID: {
      title: "Audioni qayta ishlab bo‘lmadi",
      description: "Yozuvni tekshirib, qayta urinib ko‘ring.",
    },
    AUDIO_LANGUAGE_UNSUPPORTED: {
      title: "Til qo‘llab-quvvatlanmaydi",
      description: "O‘zbek, ingliz yoki rus tilini tanlab, yangi yozuv yarating.",
    },
    NO_SPEECH_DETECTED: {
      title: "Nutq aniqlanmadi",
      description: "Aniqroq gapirib, yangi yozuv yarating.",
    },
    INVALID_REQUEST: {
      title: "Yozuv so‘rovi noto‘g‘ri",
      description: "Yangi yozuv yaratib, qayta urinib ko‘ring.",
    },
    IDEMPOTENCY_CONFLICT: {
      title: "Yozuvni davom ettirib bo‘lmadi",
      description: "Yangi yozuv boshlab, qayta urinib ko‘ring.",
    },
    SERVICE_UNAVAILABLE: {
      title: "VoiceLab vaqtincha ishlamayapti",
      description: "Yozuv qurilmada saqlandi. Qayta yubormoqchi bo‘lsangizgina urinib ko‘ring.",
    },
    PASTE_ACCESSIBILITY_REQUIRED: {
      title: "Avtomatik joylash uchun ruxsat kerak",
      description:
        "Matn clipboardga nusxalandi. Tizim sozlamalari → Maxfiylik va xavfsizlik → Qulayliklar bo‘limida VoiceLab’ni yoqing, so‘ng qayta joylang.",
    },
  },
  ru: {
    INSUFFICIENT_CREDITS: {
      title: "Нужно больше AI Credits",
      description: "Пополните баланс или выберите подходящий тариф VoiceLab.",
    },
    ENTITLEMENT_REQUIRED: {
      title: "Flow не входит в тариф",
      description: "Откройте биллинг и выберите тариф с VoiceLab Flow.",
    },
    AUTH_EXPIRED: {
      title: "Войдите снова",
      description: "Сессия завершилась. Войдите, чтобы продолжить работу с VoiceLab Cloud.",
    },
    AUTH_REQUIRED: {
      title: "Войдите, чтобы продолжить",
      description: "Войдите в аккаунт VoiceLab.",
    },
    DEVICE_LIMIT: {
      title: "Подключено слишком много устройств",
      description: "Удалите старое устройство в аккаунте и повторите попытку.",
    },
    CONCURRENCY_LIMIT: {
      title: "Другая запись обрабатывается",
      description: "Дождитесь её завершения и повторите попытку.",
    },
    DAILY_CAP_REACHED: {
      title: "Дневной лимит облака исчерпан",
      description: "Попробуйте завтра или управляйте тарифом VoiceLab.",
    },
    RATE_LIMITED: {
      title: "Подождите немного",
      description: "Получено слишком много запросов. Повторите попытку позже.",
    },
    AUDIO_LIMIT_EXCEEDED: {
      title: "Превышен лимит записи",
      description: "Запись должна быть не длиннее 300 секунд и не больше 64 МиБ.",
    },
    AUDIO_INVALID: {
      title: "Не удалось обработать аудио",
      description: "Проверьте запись и повторите попытку.",
    },
    AUDIO_LANGUAGE_UNSUPPORTED: {
      title: "Язык не поддерживается",
      description: "Выберите узбекский, английский или русский язык и создайте новую запись.",
    },
    NO_SPEECH_DETECTED: {
      title: "Речь не обнаружена",
      description: "Говорите чётче и создайте новую запись.",
    },
    INVALID_REQUEST: {
      title: "Некорректный запрос записи",
      description: "Создайте новую запись и повторите попытку.",
    },
    IDEMPOTENCY_CONFLICT: {
      title: "Не удалось продолжить эту запись",
      description: "Начните новую запись и повторите попытку.",
    },
    SERVICE_UNAVAILABLE: {
      title: "VoiceLab временно недоступен",
      description: "Запись сохранена на устройстве. Повторяйте отправку только по своему решению.",
    },
    PASTE_ACCESSIBILITY_REQUIRED: {
      title: "Нужно разрешение для автоматической вставки",
      description:
        "Текст скопирован в буфер обмена. Включите VoiceLab в Системных настройках → Конфиденциальность и безопасность → Универсальный доступ, затем вставьте снова.",
    },
  },
};

function getCopy(code?: string): RecoveryCopy | null {
  if (!code) return null;
  const language = i18next.resolvedLanguage?.split("-")[0] || "en";
  return COPY[language]?.[code] ?? COPY.en[code] ?? null;
}

export function getRecordingRecoveryAction(code?: string): RecordingRecoveryAction {
  if (!code) return null;
  if (code === "PASTE_ACCESSIBILITY_REQUIRED") return "permission";
  if (code === "AUTH_EXPIRED" || code === "AUTH_REQUIRED") return "auth";
  if (
    code === "INSUFFICIENT_CREDITS" ||
    code === "ENTITLEMENT_REQUIRED" ||
    code === "DEVICE_LIMIT"
  ) {
    return "billing";
  }
  if (code === "DAILY_CAP_REACHED") return "billing";
  if (
    code === "CONCURRENCY_LIMIT" ||
    code === "RATE_LIMITED" ||
    code === "IDEMPOTENCY_CONFLICT" ||
    code === "SERVICE_UNAVAILABLE"
  ) {
    return "retry";
  }
  return null;
}

export function getRecordingRecoveryActionLabel(action: RecordingRecoveryAction): string {
  const language = i18next.resolvedLanguage?.split("-")[0] || "en";
  const labels = {
    en: {
      auth: "Sign in",
      billing: "Manage account",
      permission: "Open Settings",
      retry: "Try again",
    },
    uz: {
      auth: "Kirish",
      billing: "Hisobni boshqarish",
      permission: "Sozlamalarni ochish",
      retry: "Qayta urinish",
    },
    ru: {
      auth: "Войти",
      billing: "Управление аккаунтом",
      permission: "Открыть настройки",
      retry: "Повторить",
    },
  };
  if (!action) return "";
  return (labels[language] ?? labels.en)[action];
}

export function getRecordingErrorTitle(error: RecordingError, t: TFunction): string {
  const copy = getCopy(error.code);
  if (copy) return copy.title;
  if (error.code === "NETWORK_ERROR") return t(error.title);
  if (error.code === "API_KEY_MISSING")
    return t("settingsPage.account.voiceLabAccount.missingTitle");
  if (error.code === "OFFLINE") return t("hooks.audioRecording.errorTitles.offline");
  if (error.code === "LIMIT_REACHED")
    return t("hooks.audioRecording.errorTitles.walletInsufficient");
  if (error.code === "PROVIDER_RATE_LIMITED")
    return t("hooks.audioRecording.errorTitles.providerRateLimited");
  return error.title;
}

/** "server_code · req_id" for support, or an empty string when neither is known. */
export function getRecordingErrorDiagnostics(error: RecordingError): string {
  return [error.serverCode, error.requestId].filter(Boolean).join(" · ");
}

export function getRecordingErrorDescription(
  error: RecordingError,
  t: TFunction,
  { includeDiagnostics = true }: { includeDiagnostics?: boolean } = {}
): string {
  const withDiagnostics = (description: string) => {
    const diagnostic = includeDiagnostics ? getRecordingErrorDiagnostics(error) : "";
    return diagnostic ? `${description} (${diagnostic})` : description;
  };
  const copy = getCopy(error.code);
  if (copy) {
    if (
      (error.code === "RATE_LIMITED" || error.code === "CONCURRENCY_LIMIT") &&
      error.retryAfterSeconds
    ) {
      const language = i18next.resolvedLanguage?.split("-")[0] || "en";
      if (language === "uz")
        return withDiagnostics(`${error.retryAfterSeconds} soniyadan keyin qayta urinib ko‘ring.`);
      if (language === "ru")
        return withDiagnostics(`Повторите попытку через ${error.retryAfterSeconds} сек.`);
      return withDiagnostics(`Try again in ${error.retryAfterSeconds} seconds.`);
    }
    if (error.code === "AUDIO_LIMIT_EXCEEDED" && error.max_duration_seconds) {
      const minutes = Math.max(1, Math.floor(error.max_duration_seconds / 60));
      const language = i18next.resolvedLanguage?.split("-")[0] || "en";
      if (language === "uz") return withDiagnostics(`Yozuvni ${minutes} daqiqadan qisqa qiling.`);
      if (language === "ru") return withDiagnostics(`Сократите запись до ${minutes} мин.`);
      return withDiagnostics(`Keep the recording under ${minutes} minutes.`);
    }
    return withDiagnostics(copy.description);
  }
  switch (error.code) {
    default:
      if (error.messageKey) return withDiagnostics(t(error.messageKey));
      return withDiagnostics(error.description ?? "");
  }
}
