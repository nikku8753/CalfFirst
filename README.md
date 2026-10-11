# CalfFirst — Phase 2

React + TypeScript + Vite + Tailwind CSS with Supabase Auth, farm management, animal profiles, and private Supabase Storage photos. The original landing page and public dashboard preview are preserved. No backend server, Docker, deployment, or paid integration is required.

## Local setup

1. Install dependencies with `npm install`.
2. Create a Supabase project on the free plan. In its SQL Editor, run the migrations **once each, in order**, as the database owner: `supabase/migrations/202610110001_foundation.sql`, then `supabase/migrations/202610110002_farm_animals.sql`. If Phase 2 is already applied, run only the new Phase 3 migration. This creates the schema, RLS policies, profile triggers, and trusted functions. Make subsequent schema changes in a new versioned migration. Do not rerun the initial migration on an already migrated database. No Supabase CLI or Docker is needed.
3. Copy `.env.example` to `.env.local`, then set:

   ```dotenv
   VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
   ```

   Find these in the project's API settings. The installed `@supabase/supabase-js` v2 supports both the newer `sb_publishable_...` key and the legacy JWT `anon` key in this variable. Never use `sb_secret_...`, a legacy `service_role` key, database passwords, or other secrets in any `VITE_` variable: Vite embeds them in the browser bundle. Configuration is validated before client creation; missing/placeholder/invalid values show a setup message instead of crashing. This guard cannot undo a secret already embedded in a build; rotate any accidentally exposed secret.
4. In Supabase Authentication settings, enable Email/password signup, choose whether email confirmation is required, and set a minimum password length of at least 8 (matching the UI). Keep anonymous sign-in disabled; this phase supports email/password accounts. Veterinarian selection is a self-declared account category, not a verified professional credential.
5. Configure Authentication → URL Configuration:

   - Site URL: `http://localhost:5173`
   - Allowed redirect URLs: `http://localhost:5173/auth/callback` and `http://localhost:5173/update-password`

   Redirects use the current origin and fixed paths. If Vite uses a different port/hostname, add that origin's two exact callback URLs too. Confirmation/recovery email templates must honor the requested redirect (default `{{ .ConfirmationURL }}` templates do). The client uses the SDK's implicit flow so emailed links work in a different browser; the SDK consumes URL tokens. Do not substitute a PKCE template without changing the callback implementation.
6. Start with `npm run dev`. Restart Vite after environment changes. On Windows with PowerShell script restrictions, use `npm.cmd` instead of `npm`.

The built-in Supabase development email service has recipient and rate restrictions. Use permitted project-team email addresses for a free-plan demonstration; check Auth logs if mail does not arrive. See [Supabase SMTP documentation](https://supabase.com/docs/guides/auth/auth-smtp) for current limits. This implementation does not require a paid SMTP service.

## Routes and behavior

| Route | Purpose |
| --- | --- |
| `/` | Original landing page |
| `/dashboard` | Public Phase 1 preview with sample records and search/filter controls |
| `/register` | Real signup; full name, email, password confirmation, Farmer/Veterinarian only |
| `/login` | Real email/password login |
| `/forgot-password` | Request password recovery email |
| `/update-password` | Set a new password with an authenticated session from a recovery link |
| `/auth/callback` | Email-confirmation callback |
| `/account` | Route signed-in users using their database profile role |
| `/dashboard/farmer` | Protected farmer dashboard with live owned-farm statistics |
| `/dashboard/veterinarian` | Protected veterinarian workspace |
| `/dashboard/admin` | Protected administrator workspace |

The farmer dashboard and `/manage` pages use only live database records; zero counts are real empty states. `/manage/farms`, `/manage/farms/new`, `/manage/farms/:farmId`, and `/manage/farms/:farmId/edit` provide farm management. Equivalent `/manage/animals` routes provide animal registration, listing, profiles, and editing. All management pages require authentication. Assigned veterinarians have read-only access. Admin and veterinarian dashboards retain their existing labeled sample tools, with links to live management. `/dashboard` remains the public Phase 1 demo. Users opening another role's dashboard are redirected to their own. Missing profiles show retry/logout rather than guessing roles from metadata.

The SDK manages persisted sessions and refresh tokens. Passwords are sent directly to Supabase Auth and never manually stored or logged. Logout removes the current browser session (other devices stay signed in). Errors distinguish invalid credentials, unconfirmed email, weak passwords, and rate limits without exposing raw server messages. With email confirmation enabled, Supabase may obscure duplicate signup with a success response; the UI uses a conditional confirmation message instead of claiming a new account was created. Reset requests also do not reveal whether an email is registered. After password update the app signs out locally and prompts for login; it reports if that sign-out failed.

## Database authorization

- `profiles`: Auth UUID primary key, full name, Auth-synchronized email, `FARMER | VETERINARIAN | ADMIN`, and timestamps. Auth deletion cascades to profiles, except farm ownership must first be resolved (`owner_id` uses `RESTRICT`).
- `farms`: UUID, name, location, optional description, immutable browser-facing owner UUID, and timestamps. Private contact information is stored separately in `farm_contacts`, which has owner/admin-only RLS. Assigned veterinarians and farmer members cannot retrieve contacts even through direct API requests.
- `farm_members`: UUID, farm UUID, user UUID, `FARMER | VETERINARIAN`, and creation timestamp. `(farm_id, user_id)` is unique; owners are represented by `farms.owner_id`, so no owner membership row is required. New memberships must match the user's database profile role.
- All tables have RLS. Anonymous clients have no table access. Users can read their own profile and update only `full_name`. Browser profile insert/delete, email/role/identity changes, and farm ownership transfers are denied.
- Farmers can create their own farms. Owners and database-profile admins can edit farm name/location, delete farms, and assign/remove members. Members can read the farm and membership list but cannot mutate the farm or manage members. Unrelated users cannot access it.
- The trusted signup INSERT trigger accepts only ordinary role categories from untrusted metadata. Anything else, including `ADMIN`, becomes `FARMER`. Later metadata changes never change profile roles. Authorization helpers query profiles using `auth.uid()`, not user-editable JWT metadata. Column grants prevent privileged writes, with identity-protection triggers as defense in depth.
- Security-definer functions use an empty fixed search path and qualified objects. Helpers avoid recursive RLS. Only policy helpers have authenticated execute permission. Keep `private` out of Supabase's exposed API schemas.
- Future health/milk tables should reference `farms.id` and use tenant RLS, such as `private.can_access_farm(farm_id)` for reads with narrower write rules. React route guards do not secure database records.

### Secure administrator provisioning

1. Have the intended administrator register normally and confirm their email. Independently verify their identity and exact Auth UUID in Supabase Authentication → Users.
2. As the project owner in SQL Editor (trusted `postgres` database context), run:

   ```sql
   select private.provision_admin('REPLACE_WITH_VERIFIED_AUTH_USER_UUID'::uuid);
   ```

   The function requires an existing confirmed Auth user/profile. `PUBLIC`, `anon`, and `authenticated` have no execute permission, and the private schema is not exposed as an RPC. Even an application ADMIN cannot invoke it. There is no public admin registration or provisioning endpoint. Protect project-owner access; no frontend service-role key is needed.
3. Refresh the account or log in again to fetch the updated profile. RLS reads database roles on each request; no metadata refresh is needed for authorization.

Downgrades/other role changes also require trusted SQL. Farm management requires a FARMER owner or ADMIN; a downgraded veterinarian cannot edit even a previously owned farm. Review existing farm memberships before changing global roles, since memberships remain until explicitly removed. Existing email-based Auth users are backfilled safely; phone-only users are outside this phase's scope.

## Verification

```sh
npm test
npm run build
```

Database tests run the actual migration in an ephemeral PGlite PostgreSQL engine with minimal Supabase Auth fixtures. They check role escalation, column protections, anonymous access, profile isolation, farm tenancy/ownership, member role matching/removal, Auth email sync, and admin provisioning. Phase 3 tests also apply both migrations with fixture `storage.buckets` and `storage.objects` tables and enforce actual PostgreSQL policies for farm/animal/contact/storage access. This is local SQL/RLS verification, not hosted Storage HTTP, signed-token, or email delivery verification. No Docker or project credentials are needed. Auth UI tests mock the SDK and exercise validation, signup/login, recovery, routing, and missing configuration without sending emails or creating users.

Before using a configured project, manually verify:

1. Signup for both ordinary roles creates the matching profile. With confirmation enabled, open the real email link; with confirmation disabled, signup immediately opens the workspace. Duplicate email never creates a second Auth account/profile.
2. Login, refresh/session restoration, wrong password, unconfirmed email, and logout.
3. Forgot password → real email link → password update → login with the new password. Also test expired/used links and a fresh browser.
4. Tampered `role: ADMIN` signup metadata creates only FARMER; later metadata changes cannot escalate. Direct API role/profile identity updates and unrelated farm reads/membership writes fail.
5. A SQL-provisioned admin reaches the admin route; ordinary users cannot invoke provisioning or access protected data.

Live email delivery and hosted Supabase behavior require an actual configured project and cannot be proven by local fixtures.

## Future hosting

No deployment, Git commit, or push is performed. For later Cloudflare Pages hosting use `npm run build` and `dist`, set the two public environment variables, and allow the site's exact `/auth/callback` and `/update-password` URLs in Supabase. `public/_redirects` provides SPA fallback. Images are remotely served from Unsplash; fonts use system fallbacks. The existing `Microsoft` directory is preserved.

## Phase 3 operations and storage

Phase 3 adds one versioned migration: `202610110002_farm_animals.sql`. The Phase 2 migration is unchanged. It adds farm descriptions, private `farm_contacts`, `animals`, atomic `save_farm` and limited `farm_people` RPCs, and the private `animal-photos` bucket with Storage policies. If setup is missing, the UI shows the relevant error and retry; it never falls back to demo records. Configure the Phase 2 public environment variables and apply both migrations before expecting live farm/animal operations.

Farm forms validate names, locations, optional descriptions, and private contact lengths. Farmers initially see owned farms and can switch to all authorized farms; assigned farm members can view but cannot manage a farm they do not own. Owners and database-profile admins can create/update records; veterinarian pages never expose edit controls. Member listing returns scoped names and roles, not emails or private contacts. Membership assignment continues to use Phase 2's policies/API; no invitation or membership-management module is added.

Animal fields include a per-farm unique uppercase identifier, name, cattle/buffalo species, breed, sex, birth date, calf/heifer/adult category, active/transferred/deceased status, optional parent UUIDs, notes, and private photo path. PostgreSQL enforces same-farm composite parent foreign keys, correct parent sex/species, strictly older parents, no self-parenting, and checks against edits that invalidate existing children. Strict parent birth-date ordering prevents cycles. Related writes are serialized using the farm row lock. A heifer must be female. Birth dates must be between 1900-01-01 and the database's current date; client validation uses the browser's local date, so the database remains authoritative around timezone boundaries. The farm UUID, animal UUID, and creation timestamp are immutable, including for admins: a future transfer workflow must be designed explicitly. TRANSFERRED is only a recorded status, not a cross-farm transfer.

Lists have name/ID/breed search, farm/species/category/status filters, stable sorting, and 10-row server pagination. Search expression punctuation and wildcard characters are treated as spaces to avoid PostgREST filter injection. Exact dashboard counts are retrieved from the database, not inferred from a limited list. Parent and farm selectors fetch successive 1,000-row ranges rather than silently truncating at the standard API row limit; keep the Supabase API maximum rows at its default 1,000 or higher. Animal edits use the original `updated_at` value for optimistic conflict detection. If another user updates the record first, reload before editing again.

### Private photos

The migration creates/locks down `animal-photos` as private, with a 5 MB file limit and JPEG/PNG/WebP MIME restrictions. The application validates type, size, and image file signatures before upload. Files use `<farm UUID>/<animal UUID>/<new object UUID>.<extension>`; no secret Storage credentials or public photo URLs are used. Read policies allow owners/admins and assigned members for photos currently attached to their farm's animals. Only owner/admin writes are allowed. Upload requires an existing managed animal. Storage UPDATE/upsert is denied: replacements use a new object. Photo paths cannot be attached to another farm/animal, and the object must exist before attachment. Existing linked files cannot be deleted until unlinked from the animal.

Photo display uses five-minute signed URLs and refreshes them while the page is open. Signed URLs are bearer links: do not share them outside the authorized workspace. Removing a membership blocks new reads/signing immediately; a previously issued signed URL may remain usable until its short expiry. No URL is stored in the animal record or localStorage.

Photo preview is local until save. Replacement uploads a new object, attaches it with a conflict check, then removes the old object. Removal clears the database link before deleting the file. Database and Storage writes cannot share a transaction: if details save but photo upload/attachment does not complete, the UI reports partial success and asks you to reload to confirm the attached photo. A rejected upload does not unlink the prior photo. Cleanup failure is also reported; it is never presented as completed cleanup. If upload/attachment is uncertain after a network interruption, reload the record before retrying. Farm owners can remove unlinked files through the Storage API under the same RLS; project owners can inspect unreferenced paths in Storage. Never delete a file still referenced by `animals.photo_path`, or enable a broad public bucket policy. Review existing custom Storage policies if applying this migration to a project with earlier hand-written permissive policies.

Deletion requires explicit UI confirmation. Animals still referenced as parents cannot be deleted until links are removed. Farms with any registered animals cannot be deleted, preventing silent loss of a herd. After an animal deletion, the UI attempts to remove its unlinked photo and reports any failure. Before deleting the last farm, resolve unlinked Storage files; once the farm is gone, its former owner loses farm-scoped cleanup access and a trusted project owner must handle leftovers. Prefer status updates to preserve animal history.

Animal profiles reserve Feeding history, Growth tracking, Vaccinations, Veterinary visits, and Milk production sections, all explicitly labeled as not implemented. No Phase 4 workflows were started.

### Phase 3 verification limits

`npm test` runs the existing Phase 2 tests, landing/public-preview regression tests, form validation and management-page tests with mocked operations, API/photo lifecycle tests with mocked SDK requests, and actual migration/RLS assertions in local PGlite PostgreSQL. Auth and Storage schemas in PGlite are minimal fixtures; no real email is sent, no image bytes are stored in Supabase, and no hosted end-to-end test is implied. No credentials are configured in this workspace.

Once a project is configured, verify the following with separate farmer A, farmer B, assigned veterinarian, and SQL-provisioned admin accounts:

1. Create a farm, save private contacts, edit it, search it, and inspect its scoped member list. Farmer B and veterinarians must not retrieve private contacts through the API.
2. Register cattle and buffalo, choose valid parents, and test duplicate IDs, future dates, same-animal/cross-farm parents, and parent sex/species/date edits. Invalid requests must fail even outside the UI.
3. Check that farmer B cannot read or mutate farmer A's animals; an assigned vet can read but cannot mutate, and loses access when unassigned. Admin operations follow the trusted profile role.
4. Upload, preview, replace, and remove each supported photo type. Reject oversized/unsupported files. Test private signed reads from a different farm account and membership removal; allow for the five-minute lifetime of already-issued links.
5. Search/filter/sort/page the animal list, view parent/profile links, and confirm the farmer dashboard's exact counts and recent registrations. Test loading, disconnected network, concurrent edits, and partial photo cleanup failures.
6. Recheck registration, login, confirmation, password reset, logout, and the unchanged public landing/demo pages. Session refresh must not discard a management form in progress.
