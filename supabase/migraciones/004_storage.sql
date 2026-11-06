-- =====================================================================
-- Remesa.cu · 004 · Archivos (Supabase Storage)
--   comprobantes/<uid del cliente>/<archivo>   captura del Zelle que sube A
--   recibos/<id de la remesa>/<archivo>        foto del recibo firmado que sube B
-- Ambos buckets son privados: se ven con URLs firmadas (createSignedUrl).
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('comprobantes', 'comprobantes', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('recibos',      'recibos',      false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

-- Comprobantes: el cliente sube y ve solo en su carpeta; el admin ve todo
create policy "comprobantes_subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'comprobantes' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "comprobantes_ver" on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes'
         and ((storage.foldername(name))[1] = auth.uid()::text or public.es_admin()));

create policy "comprobantes_admin_borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'comprobantes' and public.es_admin());

-- Recibos: solo el admin sube; el cliente ve el recibo de SU remesa
create policy "recibos_subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'recibos' and public.es_admin());

create policy "recibos_actualizar" on storage.objects for update to authenticated
  using (bucket_id = 'recibos' and public.es_admin()) with check (bucket_id = 'recibos' and public.es_admin());

create policy "recibos_ver" on storage.objects for select to authenticated
  using (bucket_id = 'recibos' and public.puede_ver_recibo(name));

create policy "recibos_borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'recibos' and public.es_admin());
