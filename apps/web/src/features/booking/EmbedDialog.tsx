/** Online booking → Embed: the code that puts a form on the business's own website, and where it goes on the usual site builders. */
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { copyText } from "@/lib/clipboard";
import { embedCode, nextEmbedCode } from "./embed";
import styles from "./EmbedDialog.module.css";

/**
 * A site builder and where the code goes in it. A site built by a developer gets DeveloperSteps
 * instead. `framed`: the builder puts the code in a frame of its own, so the page's ?promo= never
 * reaches the script (embed.ts).
 */
interface Builder { id: string; label: string; steps?: ReactNode[]; note?: ReactNode; framed?: boolean }

/** What a link with ?promo= does, where the script runs on the page itself. The code is pasted inline, so a form put on a site before the script handed codes on needs it again. */
const PAGE_PROMO = (
  <>A link to your page like <code className={styles.inline}>yoursite.com/quote?promo=SPRING15</code> fills in the code on the form. Already have the form on your site? Copy the code again and paste it over the old one, so these links work.</>
);
/** Where the builder frames the code: the form's own link (below) takes the code instead. */
const FRAMED_PROMO = (
  <>Codes in your page's link don't reach the form on this site builder. To share a promo code, use this form's own link below with <code className={`${styles.inline} nowrap`}>?promo=</code> and the code on the end.</>
);

// From each builder's help pages (October 2026). Keep in step with the embedding page in the website docs.
const BUILDERS: Builder[] = [
  {
    id: "squarespace",
    label: "Squarespace",
    steps: [
      <>Edit the page. Where the form should go, click <strong>Add block</strong> (or <strong>+</strong>), then <strong>Code</strong>.</>,
      <>Click the pencil on the new block and paste the code over what's in it. Leave <strong>Display Source</strong> off.</>,
      <>Save and publish. While you're signed in, Squarespace may not show the form; open the page in a private window to see it.</>,
    ],
    note: <>Needs the Core, Plus or Advanced plan (or Business or Commerce on older plans). On other plans, link a button to the form instead.</>,
  },
  {
    id: "wix",
    label: "Wix",
    steps: [
      <>In the Wix Editor, click <strong>Add Elements</strong>, then <strong>Embed Code</strong>, then <strong>Embed HTML</strong>.</>,
      <>Click the new box, then <strong>Enter Code</strong>. Paste the code and click <strong>Apply</strong>.</>,
      <>Drag the box's bottom edge down until the whole form shows. Wix keeps the box at the size you give it.</>,
      <>Publish.</>,
    ],
    framed: true,
  },
  {
    id: "wordpress",
    label: "WordPress",
    steps: [
      <>Edit the page. Click <strong>+</strong>, search for <strong>Custom HTML</strong>, and add that block where the form should go.</>,
      <>Paste the code into the block.</>,
      <>Click <strong>Update</strong> (or <strong>Publish</strong>).</>,
    ],
    note: <>On WordPress.com, this needs a paid plan with hosting features turned on; the free plan removes the code. WordPress sites hosted anywhere else work as they are.</>,
  },
  {
    id: "godaddy",
    label: "GoDaddy",
    steps: [
      <>In the website editor, hover between two sections and click <strong>+</strong> to add a section. Search for <strong>HTML</strong> and add it.</>,
      <>Paste the code into <strong>Custom Code</strong> and click <strong>Done</strong>.</>,
      <>Publish.</>,
    ],
    framed: true,
  },
  {
    id: "google-sites",
    label: "Google Sites",
    steps: [
      <>Click <strong>Insert</strong>, then <strong>Embed</strong>, then the <strong>Embed code</strong> tab.</>,
      <>Paste the code, click <strong>Next</strong>, then <strong>Insert</strong>.</>,
      <>Drag the box's bottom edge down until the whole form shows, then <strong>Publish</strong>.</>,
    ],
    framed: true,
  },
  { id: "developer", label: "Built by a developer" },
  {
    id: "other",
    label: "Something else",
    steps: [
      <>Find the block for adding your own code. It's usually called <strong>Embed</strong>, <strong>HTML</strong>, <strong>Custom code</strong> or <strong>Code</strong>.</>,
      <>Paste the code into it where the form should go, and publish.</>,
      <>If the form shows in a box with its own scroll bar, the site builder left out the part that fits it to the form. It still works; make the box taller if you can. Codes in your page's link won't reach it then either, so share the form's own link below with the code.</>,
    ],
  },
];

export function EmbedDialog({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const code = embedCode(url, name);
  const [builderId, setBuilderId] = useState(BUILDERS[0]!.id);
  const builder = BUILDERS.find((b) => b.id === builderId) ?? BUILDERS[0]!;

  return (
    <Dialog open onClose={onClose} title="Put this form on your website" description={name} size="lg">
      <div className="dialog-body">
        <div className="stack-sm">
          <pre className={styles.code}>{code}</pre>
          <Button variant="primary" icon="copy" style={{ justifySelf: "start" }} onClick={() => copyText(code, "Embed code copied")}>Copy code</Button>
          <span className="muted small">Paste it where the form should go. The form grows and shrinks to fit, and what people send comes in under Requests, the same as from the link.</span>
        </div>
        <Field label="Your website is on">
          <select className="select" value={builder.id} onChange={(e) => setBuilderId(e.target.value)}>
            {BUILDERS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </Field>
        {builder.steps ? (
          <ol className={styles.steps} aria-label={`Steps for ${builder.label}`}>
            {builder.steps.map((step, i) => <li key={`${builder.id}-${i}`}>{step}</li>)}
          </ol>
        ) : (
          <DeveloperSteps name={name} url={url} />
        )}
        {builder.note && <p className="muted small" style={{ margin: 0 }}>{builder.note}</p>}
        <p className="muted small" style={{ margin: 0 }}>{builder.framed ? FRAMED_PROMO : PAGE_PROMO}</p>
        <div className={`stack-sm ${styles.panel}`}>
          <strong>Can't add code? Link to the form instead</strong>
          <span className="muted small">Any website can have a button, like “Get a quote”, that opens the form's link. It works on every plan.</span>
          <span className={styles.copy}>
            <code className="code-pill grow">{url}</code>
            <Button size="sm" icon="copy" aria-label="Copy link" onClick={() => copyText(url, "Link copied")}>Copy</Button>
          </span>
          <span className="muted small">With a promo code, add it on the end: <code className={styles.inline}>{`${url}?promo=SPRING15`}</code></span>
        </div>
      </div>
    </Dialog>
  );
}

type Framework = "astro" | "next" | "other";

/** For a site in code: Astro takes the code as it is, Next.js gets it as a component (embed.ts). */
function DeveloperSteps({ name, url }: { name: string; url: string }) {
  const [framework, setFramework] = useState<Framework>("astro");
  const component = nextEmbedCode(url, name);
  const pick = (value: Framework, label: string) => <button type="button" aria-pressed={framework === value} onClick={() => setFramework(value)}>{label}</button>;
  return (
    <div className="stack-sm">
      <div className="segmented" role="group" aria-label="Built with" style={{ justifySelf: "start" }}>
        {pick("astro", "Astro")}
        {pick("next", "Next.js")}
        {pick("other", "Other")}
      </div>
      {framework === "astro" ? (
        <ol className={styles.steps} aria-label="Steps for Astro">
          <li>Paste the code above into a <code className={styles.inline}>.astro</code> page or component, where the form should go. Astro bundles the script, which is fine. With two forms on a page, the script only needs to be there once.</li>
          <li>Not straight into an <code className={styles.inline}>.mdx</code> page: MDX reads the script's braces as code. Put the form in a <code className={styles.inline}>.astro</code> component and use that there.</li>
        </ol>
      ) : framework === "next" ? (
        <ol className={styles.steps} aria-label="Steps for Next.js">
          <li>
            <div className="stack-sm">
              <span>Use this instead of the code above. JSX can't take that as it is, and React won't reliably run a script written into a page. Save it as a component, like <code className={styles.inline}>components/BookingForm.tsx</code> (or <code className={styles.inline}>.jsx</code>):</span>
              <pre className={styles.code}>{component}</pre>
              <Button size="sm" icon="copy" style={{ justifySelf: "start" }} onClick={() => copyText(component, "Component copied")}>Copy component</Button>
            </div>
          </li>
          <li>Render <code className={styles.inline}>{"<BookingForm />"}</code> where the form should go. It works in the App Router (as a server component) and the Pages Router.</li>
        </ol>
      ) : (
        <ol className={styles.steps} aria-label="Steps for other sites">
          <li>Plain HTML pages, or the templates of a site generator like Hugo, Eleventy or Jekyll: paste the code above as it is. Markdown files may strip it out.</li>
          <li>In an app framework (React, Vue, Svelte), render the frame like the Next.js version does and load the script once, from the page's <code className={styles.inline}>{"<head>"}</code>. A script inside a component's markup usually doesn't run.</li>
        </ol>
      )}
    </div>
  );
}
