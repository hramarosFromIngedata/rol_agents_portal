"use client";

export type ToastItem = {
  id: number;
  message: string;
  type: "success" | "error";
};

export default function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed top-5 left-1/2 z-[9999] flex -translate-x-1/2 flex-col items-center gap-3"
      aria-live="polite"
      aria-atomic="true"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={[
            "pointer-events-auto flex min-w-[260px] max-w-[360px] cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-[0.95rem] text-white shadow-[0_12px_40px_rgba(0,0,0,0.35)]",
            "animate-[toast-in_220ms_ease]",
            t.type === "success"
              ? "border-emerald-400/20 bg-emerald-500 text-[#e8fff0]"
              : "border-red-400/25 bg-red-500",
          ].join(" ")}
        >
          <div className="h-5 w-5 flex-none">
            {t.type === "success" ? (
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="#2ecc71"
                strokeWidth={2}
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="#ff4d4d"
                strokeWidth={2}
              >
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
                <circle cx="12" cy="12" r="10" />
              </svg>
            )}
          </div>
          <div className="flex-1">{t.message}</div>
        </div>
      ))}
    </div>
  );
}
