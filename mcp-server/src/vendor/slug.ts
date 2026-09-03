/**
 * 生成文件名安全的 slug:
 * 小写、非字母数字转 `-`、合并连续 `-`、去首尾 `-`、截断 60 字符。
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}
