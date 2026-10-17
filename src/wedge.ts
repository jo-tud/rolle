/**
 * USB and Bluetooth hand scanners act as a keyboard: they type the code very fast and press Enter
 * (some send Tab). This catches such bursts anywhere on the page, without a focused text field, so
 * spool after spool can be scanned without touching the screen. Keys typed by hand are slower and
 * reset the buffer.
 */

/** Longest pause between two keys of one scan. Hand typing is slower than this. */
export const MAX_GAP_MS = 120;
/** Shorter bursts are taken as typing (or a stray key), not as a code. */
export const MIN_LENGTH = 3;

export class WedgeBuffer {
  private chars = '';
  private last = -Infinity;

  /**
   * Feeds one key. Returns the scanned code when the key ends a scan, otherwise null. `consume`
   * tells whether the key belongs to a scan in progress (so the page should not act on it).
   */
  feed(key: string, time: number): { code: string | null; consume: boolean } {
    const fresh = time - this.last <= MAX_GAP_MS;
    if (key === 'Enter' || key === 'Tab') {
      const code = fresh && this.chars.length >= MIN_LENGTH ? this.chars : null;
      this.reset();
      return { code, consume: code !== null };
    }
    if (key.length !== 1) {
      // Shift and the like arrive between characters of the code; other keys end the burst.
      if (key !== 'Shift' && key !== 'AltGraph' && key !== 'Alt' && key !== 'Control') this.reset();
      return { code: null, consume: false };
    }
    const continues = fresh && this.chars.length > 0;
    if (!continues) this.chars = '';
    this.chars += key;
    this.last = time;
    return { code: null, consume: continues };
  }

  reset(): void {
    this.chars = '';
    this.last = -Infinity;
  }
}

const isEditable = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'color', 'file', 'range'].includes(el.type);
  }
  return false;
};

/**
 * Listens for scanner bursts on the whole document. Text fields keep their keys (a scan into the
 * search box stays a search), and so does a page with an open dialog.
 */
export function listenForScanner(onCode: (code: string) => void, enabled: () => boolean): () => void {
  const buffer = new WedgeBuffer();
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || isEditable(e.target) || !enabled()) {
      buffer.reset();
      return;
    }
    const { code, consume } = buffer.feed(e.key, e.timeStamp || performance.now());
    // Without this, the Enter at the end of a scan would also press whatever button has focus.
    if (consume) e.preventDefault();
    if (code) onCode(code);
  };
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}
