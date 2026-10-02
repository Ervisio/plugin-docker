import { useRef } from 'react';
import { Button } from '../kit';

/** A button that opens the browser's file chooser and hands back the text of the chosen file. */
export function FilePicker({ label, accept, icon = 'upload', size = 'sm', variant = 'ghost', onText, onError }: {
  label: string;
  accept?: string;
  icon?: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
  onText(text: string, name: string): void;
  onError?(e: Error): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button size={size} variant={variant} icon={icon} onClick={() => ref.current?.click()}>{label}</Button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        data-testid="file-picker"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (f.size > 4 * 1024 * 1024) return onError?.(new Error('too big'));
          f.text().then((txt) => onText(txt, f.name), (err) => onError?.(err as Error));
        }}
      />
    </>
  );
}
