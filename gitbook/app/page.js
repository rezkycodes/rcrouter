import { DEFAULT_LANG } from "@/constants/languages";

// Plain <a>, <meta> and location.replace do not get Next's basePath, so prefix it
// here. Without it, a project-Pages deploy (/<repo>/) would redirect to /en/.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const TARGET = `${BASE_PATH}/${DEFAULT_LANG}/`;

// Static-friendly redirect to default language (meta refresh + client script)
export const metadata = {
  title: "Redirecting...",
  other: {
    "http-equiv:refresh": `0; url=${TARGET}`
  }
};

export default function HomePage() {
  const target = TARGET;
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `window.location.replace("${target}");`
        }}
      />
      <meta httpEquiv="refresh" content={`0; url=${target}`} />
      <p style={{ padding: "2rem", textAlign: "center" }}>
        Redirecting to <a href={target}>{target}</a>...
      </p>
    </>
  );
}
