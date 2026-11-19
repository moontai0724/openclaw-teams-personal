export const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const mentionPattern = /@\[([^\]\r\n]{1,100})\]\((8:[^\s()<>"']{1,200})\)/g;
const styleMarkers = {
  bold: { open: '<strong>', close: '</strong>' },
  italic: { open: '<em>', close: '</em>' },
};

function nativeMention(mentions, name, mri) {
  const itemid = String(mentions.length);
  mentions.push({ '@type': 'http://schema.skype.com/Mention', itemid, mri, mentionType: 'person', displayName: name });
  return `<readonly contenteditable="false"><span itemtype="http://schema.skype.com/Mention" itemscope itemid="${itemid}">${escapeHtml(name)}</span></readonly>`;
}

function propertiesFor(mentions) {
  return mentions.length ? { mentions: JSON.stringify(mentions) } : {};
}

// Standalone transport callers can still supply literal text without the OpenClaw SDK.
function composePlainText(text) {
  const mentions = [];
  let position = 0;
  let html = '';
  for (const match of text.matchAll(mentionPattern)) {
    html += escapeHtml(text.slice(position, match.index)) + nativeMention(mentions, match[1], match[2]);
    position = match.index + match[0].length;
  }
  html += escapeHtml(text.slice(position));
  return { content: `<p>${html.replace(/\r?\n/g, '<br>')}</p>`, properties: propertiesFor(mentions) };
}

export function composeText(text, format = composePlainText) {
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) {
    throw new Error('A nonempty Teams message of at most 20000 characters is required');
  }
  return format(text);
}

function buildLink(link) {
  if (!/^https?:\/\//i.test(link.href) || !URL.canParse(link.href)) return null;
  return { start: link.start, end: link.end, open: `<a href="${escapeHtml(link.href)}">`, close: '</a>' };
}

export function createTeamsTextFormatter({ markdownToIR, renderMarkdownWithMarkers, sliceMarkdownIR }) {
  return text => {
    const ir = markdownToIR(text, {
      headingStyle: 'bold',
      tableMode: 'bullets',
      blockquotePrefix: '› ',
      enableTaskLists: true,
      preserveSourceBlockSpacing: true,
    });
    const mentions = [];
    const explicitMentions = new Set(Array.from(text.matchAll(mentionPattern), match => match[0]));
    const boundaries = [];
    for (const link of ir.links) {
      const start = link.start - 1;
      const name = ir.text.slice(link.start, link.end);
      // Code spans and HTML attributes are not parsed as links by the SDK.
      if (ir.text[start] === '@' && explicitMentions.has(`@[${name}](${link.href})`)) {
        boundaries.push({ start, end: link.end, mention: { name, mri: link.href } });
      }
    }

    for (const match of ir.text.matchAll(/\n{2,}/g)) {
      const start = match.index;
      const end = start + match[0].length;
      // Do not split code or drop its blank lines as if they were paragraph breaks.
      if (!ir.styles.some(span => span.start < end && span.end > start) &&
          !ir.links.some(link => link.start < end && link.end > start)) {
        boundaries.push({ start, end });
      }
    }

    const renderOptions = {
      styleMarkers,
      buildLink,
      escapeText: value => escapeHtml(value)
        .replace(/ {2,}/g, spaces => '&nbsp;'.repeat(spaces.length - 1) + ' ')
        .replace(/\n/g, '<br>'),
    };
    const render = (start, end) => start === end ? '' : renderMarkdownWithMarkers(
      start === 0 && end === ir.text.length ? ir : sliceMarkdownIR(ir, start, end), renderOptions);
    let position = 0;
    let paragraph = '';
    const paragraphs = [];
    for (const boundary of boundaries.sort((a, b) => a.start - b.start)) {
      paragraph += render(position, boundary.start);
      if (boundary.mention) {
        paragraph += nativeMention(mentions, boundary.mention.name, boundary.mention.mri);
      } else {
        paragraphs.push(paragraph);
        paragraph = '';
      }
      position = boundary.end;
    }
    paragraphs.push(paragraph + render(position, ir.text.length));
    const content = paragraphs.map(body => `<p>${body}</p>`).join('');
    return { content, properties: propertiesFor(mentions) };
  };
}
