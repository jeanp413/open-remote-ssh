const ID_REGEX = /^[\w-]+\.[\w-]+$/;

export function sanitizeExtensionIds(ids: string[]): string[] {
    return ids.filter((id) => ID_REGEX.test(id))
}
