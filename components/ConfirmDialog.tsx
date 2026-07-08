"use client";

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "Annuler",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-sm rounded-3xl border border-white/20 bg-[#0044ff] p-8 text-white shadow-[0_20px_40px_rgba(0,0,0,0.4)]">
        <h3 className="font-heading mb-3 text-xl font-semibold">{title}</h3>
        <p className="mb-6 text-sm leading-relaxed text-white/80">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-white/15"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[#002266] transition-colors hover:bg-neutral-100"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
