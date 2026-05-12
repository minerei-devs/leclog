import { useEffect, useId } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  isBusy?: boolean;
  confirmDisabled?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  details = [],
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  isBusy = false,
  confirmDisabled = false,
  error,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isBusy) {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isBusy, onCancel, open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-[2px]"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label={cancelLabel}
        disabled={isBusy}
        onClick={onCancel}
      />
      <section className="relative grid w-full max-w-md gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 rounded-lg border border-red-100 bg-red-50 p-2 text-red-600">
              <AlertTriangle className="size-4" />
            </div>
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold text-slate-950">
                {title}
              </h2>
              <p id={descriptionId} className="mt-1 text-sm leading-5 text-slate-600">
                {description}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={cancelLabel}
            disabled={isBusy}
            onClick={onCancel}
          >
            <X className="size-4" />
          </Button>
        </div>

        {details.length > 0 ? (
          <div className="grid gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            {details.map((detail) => (
              <p key={detail} className="truncate text-xs text-slate-600" title={detail}>
                {detail}
              </p>
            ))}
          </div>
        ) : null}

        {error ? (
          <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" disabled={isBusy} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={isBusy || confirmDisabled}
            onClick={onConfirm}
          >
            {isBusy ? "Deleting..." : confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}
