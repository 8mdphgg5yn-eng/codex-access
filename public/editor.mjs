export function replaceFirst(text, find, replacement) {
  if (!find) throw new Error('先填入要查找的文字。');
  const index = text.indexOf(find);
  if (index === -1) throw new Error('草稿中没有找到这段文字。');
  return { text: text.slice(0, index) + replacement + text.slice(index + find.length), index, count: text.split(find).length - 1 };
}
export function deleteLastSentence(text) {
  const trimmed = text.trimEnd();
  const withoutEnding = trimmed.replace(/[。！？.!?]+$/u, '');
  const boundary = Math.max(...['。', '！', '？', '.', '!', '?', '\n'].map(mark => withoutEnding.lastIndexOf(mark)));
  return boundary < 0 ? '' : trimmed.slice(0, boundary + 1);
}
export class Draft {
  constructor() { this.text = ''; this.history = []; }
  update(text) { if (text === this.text) return; this.history.push(this.text); this.history = this.history.slice(-80); this.text = text; }
  undo() { if (this.history.length) this.text = this.history.pop(); return this.text; }
}
