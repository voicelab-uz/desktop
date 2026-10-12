import * as React from "react";

export interface ToastProps {
  id?: string;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  /** Technical details (error code, request id) shown small and copyable. */
  meta?: string;
  icon?: React.ReactNode;
  variant?: "default" | "destructive" | "success";
  duration?: number;
  onClose?: () => void;
}

export interface ToastRecord extends ToastProps {
  id: string;
  isExiting?: boolean;
  createdAt: number;
}

export interface ToastContextType {
  toast: (props: Omit<ToastProps, "id">) => string;
  dismiss: (id?: string) => void;
  toastCount: number;
  /** Live list, newest last. The dictation overlay renders these itself. */
  toasts: ToastRecord[];
  pauseTimer: (id: string) => void;
  resumeTimer: (id: string, remainingTime: number) => void;
}

export const ToastContext = React.createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
};
