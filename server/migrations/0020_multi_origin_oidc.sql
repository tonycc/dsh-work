-- Expand the short-lived OIDC transaction so the callback always uses the
-- exact origin and redirect URI selected when login started. Columns remain
-- nullable so an older application release can still run during rollback.

alter table oidc_login_transactions
  add column if not exists portal_origin text,
  add column if not exists redirect_uri text;
