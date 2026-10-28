/** Add, rename, reorder and remove knowledge base categories, and give them cover photos. Changes save as you make them. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Button, Spinner } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { coverPicture, uploadFile } from "@/lib/files";
import { useSession } from "@/lib/session";
import { GuideCover } from "./GuideCover";
import { useCategories } from "./kbData";

export function CategoriesDialog({ onClose, counts }: { onClose: () => void; counts: (id: string) => number }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const categories = useCategories();
  const [name, setName] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["kb", company.id] });

  const add = useMutation({
    meta: { inline: true, success: "Category added" },
    mutationFn: async (value: string) => {
      const list = categories.data ?? [];
      if (list.some((c) => c.name.toLowerCase() === value.toLowerCase())) throw new Error("There's already a category with that name.");
      unwrap(await supabase().from("sop_categories").insert({ company_id: company.id, name: value, sort: (list.at(-1)?.sort ?? 0) + 1 }));
    },
    onSuccess: () => { setName(""); refresh(); },
  });
  const rename = useMutation({
    meta: { success: "Category renamed" },
    mutationFn: async ({ id, value }: { id: string; value: string }) => unwrap(await supabase().from("sop_categories").update({ name: value }).eq("id", id)),
    onSettled: refresh,
  });
  const move = useMutation({
    mutationFn: async ({ index, dir }: { index: number; dir: -1 | 1 }) => {
      const list = [...(categories.data ?? [])];
      const [item] = list.splice(index, 1);
      list.splice(index + dir, 0, item!);
      await Promise.all(list.map((c, i) => supabase().from("sop_categories").update({ sort: i }).eq("id", c.id).then((r) => unwrap(r))));
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    meta: { success: "Category removed" },
    mutationFn: async (id: string) => {
      const cover = categories.data?.find((c) => c.id === id)?.cover_path;
      unwrap(await supabase().from("sop_categories").delete().eq("id", id));
      if (cover) void supabase().storage.from("files").remove([cover]);
    },
    onSettled: refresh,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) add.mutate(name.trim());
  };

  return (
    <Dialog open onClose={onClose} title="Categories" description="A category's photo shows on its card in the knowledge base." size="md">
      <div className="stack">
        <div className="card" style={{ boxShadow: "none" }}>
          {categories.isPending && [0, 1, 2].map((i) => <div key={i} className="card-row"><Skeleton height={34} radius={8} /></div>)}
          {categories.data?.length === 0 && <p className="muted small" style={{ margin: 0, padding: 16 }}>No categories yet.</p>}
          {categories.data?.map((c, i) => (
            <div key={c.id} className="card-row" style={{ padding: "8px 10px", gap: 6 }}>
              <CategoryPhoto category={c} />
              <input
                className="input grow"
                defaultValue={c.name}
                maxLength={60}
                aria-label={`Name of ${c.name}`}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  if (!value) e.target.value = c.name;
                  else if (value !== c.name) rename.mutate({ id: c.id, value });
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
              />
              <span className="muted small nowrap" style={{ width: 52, textAlign: "right" }}>{counts(c.id)} {counts(c.id) === 1 ? "guide" : "guides"}</span>
              <button type="button" className="icon-btn" aria-label={`Move ${c.name} up`} disabled={i === 0 || move.isPending} onClick={() => move.mutate({ index: i, dir: -1 })}><Icon name="chevronUp" size={16} /></button>
              <button type="button" className="icon-btn" aria-label={`Move ${c.name} down`} disabled={i === categories.data.length - 1 || move.isPending} onClick={() => move.mutate({ index: i, dir: 1 })}><Icon name="chevronDown" size={16} /></button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${c.name}`}
                onClick={async () => {
                  const n = counts(c.id);
                  if (await confirm({ title: `Remove “${c.name}”?`, body: n ? `Its ${n} ${n === 1 ? "guide moves" : "guides move"} to Uncategorized. Nothing is deleted.` : "This category is empty.", confirmLabel: "Remove", danger: true })) remove.mutate(c.id);
                }}
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
        </div>
        <form className="row" style={{ gap: 8 }} onSubmit={submit}>
          <input className="input grow" value={name} onChange={(e) => { setName(e.target.value); add.reset(); }} placeholder="New category, e.g. Equipment" maxLength={60} aria-label="New category name" />
          <Button type="submit" icon="plus" loading={add.isPending} disabled={!name.trim()}>Add</Button>
        </form>
        <FormError error={add.error} />
        <div className="form-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </div>
    </Dialog>
  );
}

/** A category's cover photo: its thumbnail adds one, or opens a menu to change or remove it. */
function CategoryPhoto({ category }: { category: { id: string; name: string; cover_path: string | null } }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const save = useMutation({
    meta: { success: (_: unknown, file: File | null) => (file ? "Photo saved" : "Photo removed") },
    mutationFn: async (file: File | null) => {
      let path: string | null = null;
      if (file) {
        const jpeg = await coverPicture(file);
        if (!jpeg) throw new Error("Crewtavo can't open that picture here. Try a JPEG or PNG.");
        path = await uploadFile(company.id, "kb", new File([jpeg], "cover.jpg", { type: "image/jpeg" }));
      }
      try {
        unwrap(await supabase().from("sop_categories").update({ cover_path: path }).eq("id", category.id));
      } catch (error) {
        if (path) void supabase().storage.from("files").remove([path]);
        throw error;
      }
      if (category.cover_path) void supabase().storage.from("files").remove([category.cover_path]);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["kb", company.id] }),
  });
  const pick = () => input.current?.click();
  const thumb = save.isPending ? (
    <span className="guide-cover guide-thumb"><Spinner size={14} /></span>
  ) : category.cover_path ? (
    <GuideCover path={category.cover_path} className="guide-thumb" />
  ) : (
    <span className="guide-cover guide-thumb" data-empty><Icon name="image" size={16} /></span>
  );
  return (
    <>
      {category.cover_path && !save.isPending ? (
        <Menu
          label={`Photo for ${category.name}`}
          trigger={thumb}
          triggerClassName="category-photo"
          align="start"
          items={[
            { label: "Change photo", icon: "image", onSelect: pick },
            { label: "Remove photo", icon: "trash", danger: true, onSelect: () => save.mutate(null) },
          ]}
        />
      ) : (
        <button type="button" className="category-photo" aria-label={`Add a photo for ${category.name}`} title="Add a photo" disabled={save.isPending} onClick={pick}>{thumb}</button>
      )}
      <input ref={input} type="file" accept="image/*,.heic,.heif" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) save.mutate(file); }} />
    </>
  );
}
