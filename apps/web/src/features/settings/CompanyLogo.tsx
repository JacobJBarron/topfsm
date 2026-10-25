/**
 * Adding, changing and removing the business logo (PUT and DELETE /api/company/logo), in Settings →
 * Company. Clients see it on the Client Hub (and so on printed and PDF quotes and invoices) and at
 * the top of emails. The picture becomes a trimmed PNG on this device first, see-through background
 * and all.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { base64Of, logoPicture } from "@/lib/files";
import { useSession } from "@/lib/session";

export function CompanyLogo({ path }: { path: string | null }) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  // Settings → Company saves the settings it loaded, so it reloads them with the new logo, and the
  // session's copy has it too, for the top bar.
  const changed = () => {
    queryClient.invalidateQueries({ queryKey: ["company", company.id] });
    session.refresh();
  };
  const set = useMutation({
    meta: { success: "Logo saved" },
    mutationFn: async (file: File) => {
      const png = await logoPicture(file);
      if (!png) throw new Error("Crewtavo can't open that picture. Try a PNG, JPEG or SVG.");
      return api.put<{ logo: string }>("/company/logo", { logo: await base64Of(png) });
    },
    onSuccess: changed,
  });
  const remove = useMutation({
    meta: { success: "Logo removed" },
    mutationFn: () => api.delete("/company/logo"),
    onSuccess: changed,
  });
  return (
    <div className="row wrap" style={{ gap: 12 }}>
      {/* On white, as clients see it. */}
      {path && (
        <span style={{ display: "grid", placeItems: "center", height: 64, minWidth: 64, padding: "0 14px", background: "#fff", border: "1px solid var(--border)", borderRadius: 10 }}>
          <img src={`/api/public/logo/${path.replace("/logo/", "/")}`} alt="Your logo" style={{ display: "block", maxHeight: 40, maxWidth: 180, objectFit: "contain" }} />
        </span>
      )}
      <div className="stack-sm" style={{ gap: 6 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <Button size="sm" icon="upload" loading={set.isPending} disabled={remove.isPending} onClick={() => input.current?.click()}>
            {path ? "Change logo" : "Add your logo"}
          </Button>
          {path && <Button size="sm" variant="ghost" loading={remove.isPending} disabled={set.isPending} onClick={() => remove.mutate()}>Remove logo</Button>}
        </div>
        <span className="muted small">A PNG or SVG with a see-through background looks best.</span>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*,.svg,.heic,.heif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) set.mutate(file);
        }}
      />
    </div>
  );
}
