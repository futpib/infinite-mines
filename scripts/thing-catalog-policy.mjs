// For Noto's pinned source commit, this structural rule exactly matches the
// multi-person short-name categories in Unicode Emoji 17.0's emoji-test.txt:
// https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt
const MULTI_PERSON_ROOTS = new Set([
  "1f465", // busts in silhouette
  "1f46a", // family
  "1f46b", // woman and man holding hands
  "1f46c", // men holding hands
  "1f46d", // women holding hands
  "1f46f", // people with bunny ears
  "1f48f", // kiss
  "1f491", // couple with heart
  "1f93c", // people wrestling
  "1fac2", // people hugging
]);

const PERSON_COMPONENTS = new Set([
  "1f466", // boy
  "1f467", // girl
  "1f468", // man
  "1f469", // woman
  "1f474", // old man
  "1f475", // old woman
  "1f476", // baby
  "1f9d1", // person
  "1f9d2", // child
]);

export const isMultiPersonThingFilename = (filename) => {
  const match = /^emoji_u([0-9a-f_]+)\.svg$/.exec(filename);
  if (!match) return false;
  const codepoints = match[1].split("_");
  return MULTI_PERSON_ROOTS.has(codepoints[0]) || codepoints.filter((codepoint) => PERSON_COMPONENTS.has(codepoint)).length >= 2;
};
