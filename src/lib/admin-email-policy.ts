const DEFAULT_OWNER_ADMIN_EMAIL = 'weishenooi2003@gmail.com';

export function getAdminEmail(...args: [configuredEmail?: string | undefined]): string {
  const configuredEmail =
    args.length > 0 ? args[0] : (process.env.ADMIN_EMAIL || DEFAULT_OWNER_ADMIN_EMAIL);
  return (configuredEmail || '').trim().toLowerCase();
}

export function isAdminEmail(
  email?: string | null,
  ...args: [configuredAdminEmail?: string | undefined]
): boolean {
  if (!email) return false;
  const adminEmail = args.length > 0 ? getAdminEmail(args[0]) : getAdminEmail();
  return Boolean(adminEmail) && email.trim().toLowerCase() === adminEmail;
}
