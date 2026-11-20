-- Hardening on top of 002 (002 is not edited). Chalane ka tareeka: Supabase SQL Editor -> paste -> Run.
-- Browser (authenticated) se direct writes jo server-side checks bypass karte the, ab band.

-- messages: sirf server (service role) likhta hai. Pehle koi bhi user 'assistant' role ki fake rows daal sakta tha.
drop policy if exists messages_insert on messages;
revoke insert on messages from authenticated;

-- client_accounts / sites: banana sirf API route se (owner check + Meta token/currency verification, site key generation).
drop policy if exists client_accounts_insert_owner on client_accounts;
drop policy if exists sites_insert_owner on sites;
revoke insert on client_accounts from authenticated;
revoke insert on sites from authenticated;

-- conversations / messages: padhna sirf banane wale user ko (teammate ki private chat nahi), apni agency ke andar.
drop policy if exists conversations_select on conversations;
create policy conversations_select on conversations for select to authenticated
  using (user_id = auth.uid()
    and tenant_id in (select tenant_id from memberships where user_id = auth.uid()));

drop policy if exists messages_select on messages;
create policy messages_select on messages for select to authenticated
  using (conversation_id in (select id from conversations where user_id = auth.uid()
        and tenant_id in (select tenant_id from memberships where user_id = auth.uid())));
