-- A knowledge base category's cover photo, shown on its card, like a guide's (20261028000200): a
-- picture in the files bucket under <company>/kb/.
alter table public.sop_categories add column cover_path text
  check (cover_path is null or (private.path_company(cover_path) = company_id and split_part(cover_path, '/', 2) = 'kb'));

notify pgrst, 'reload schema';
