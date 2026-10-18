// School years start in September; the teacher can change this default for historical files.
export function currentSchoolYear(date = new Date()) {
  const start = date.getFullYear() - (date.getMonth() < 8 ? 1 : 0);
  return `${start}—${start + 1} 学年`;
}
