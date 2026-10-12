import { useCallback, useEffect, useRef, useState } from "react";

export type MicLevelError = "not-allowed" | "not-found" | "in-use" | "unknown";

export interface MicLevelDevice {
  deviceId: string;
  label: string;
}

interface UseMicLevelResult {
  /** Per-band levels in the 0..1 range, resampled to `bandCount` entries. */
  bands: number[];
  /** True once sustained speech-level input has been observed. */
  speechDetected: boolean;
  error: MicLevelError | null;
  devices: MicLevelDevice[];
  refreshDevices: () => Promise<void>;
}

const SPEECH_THRESHOLD = 0.12;
const SPEECH_FRAMES_REQUIRED = 6;

function classifyError(error: unknown): MicLevelError {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "not-allowed";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "not-found";
  if (name === "NotReadableError" || name === "AbortError") return "in-use";
  return "unknown";
}

/**
 * Opens the selected microphone and streams a lightweight frequency-band
 * visualisation plus a latched "speech detected" flag for the onboarding
 * microphone test. The stream is released on unmount or device change.
 */
export function useMicLevel(deviceId: string, bandCount = 24): UseMicLevelResult {
  const [bands, setBands] = useState<number[]>(() => new Array(bandCount).fill(0));
  const [speechDetected, setSpeechDetected] = useState(false);
  const [error, setError] = useState<MicLevelError | null>(null);
  const [devices, setDevices] = useState<MicLevelDevice[]>([]);
  const speechFramesRef = useRef(0);

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(
        all
          .filter((device) => device.kind === "audioinput")
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label || `Microphone ${device.deviceId.slice(0, 6)}`,
          }))
      );
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;

    speechFramesRef.current = 0;
    setSpeechDetected(false);
    setError(null);

    const start = async () => {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      };
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (firstError) {
        // A stale device id should not block the test; retry with the default input.
        if (deviceId && classifyError(firstError) === "not-found") {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } catch (secondError) {
            if (!cancelled) setError(classifyError(secondError));
            return;
          }
        } else {
          if (!cancelled) setError(classifyError(firstError));
          return;
        }
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      void refreshDevices();

      context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      // Voice energy sits in the lower bins; ignore the upper half of the spectrum.
      const usableBins = Math.floor(data.length / 2);
      const binsPerBand = Math.max(1, Math.floor(usableBins / bandCount));

      const tick = () => {
        if (cancelled) return;
        analyser.getByteFrequencyData(data);
        const next: number[] = [];
        let total = 0;
        for (let band = 0; band < bandCount; band += 1) {
          let sum = 0;
          for (let bin = 0; bin < binsPerBand; bin += 1) {
            sum += data[band * binsPerBand + bin] ?? 0;
          }
          const level = sum / binsPerBand / 255;
          next.push(level);
          total += level;
        }
        const average = total / bandCount;
        if (average > SPEECH_THRESHOLD) {
          speechFramesRef.current += 1;
          if (speechFramesRef.current >= SPEECH_FRAMES_REQUIRED) setSpeechDetected(true);
        } else {
          speechFramesRef.current = 0;
        }
        setBands(next);
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    };

    void start();

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
    };
  }, [bandCount, deviceId, refreshDevices]);

  return { bands, speechDetected, error, devices, refreshDevices };
}

export default useMicLevel;
