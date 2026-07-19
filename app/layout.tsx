import type { Metadata } from "next";
import "@fontsource/comfortaa/600.css";
import "@fontsource/comfortaa/700.css";
import "./globals.css";

// Treat empty strings from misconfigured env as missing so the
// fallback URL is always a valid absolute URL during build.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://aidofor.me";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "AidoFor.me — From assignment brief to verified writing plan",
    template: "%s · AidoFor.me",
  },
  description:
    "Turn an assignment brief and rubric into a verified, source-backed writing plan. Research with evidence and write in your voice.",
  applicationName: "AidoFor.me",
  alternates: { canonical: "/" },
  icons: {
    icon: "/brand/aidoforme-mark.svg",
    apple: "/brand/aidoforme-profile.png",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "AidoFor.me",
    title: "Your assignment, understood before you write",
    description:
      "A source-grounded academic writing workspace that keeps requirements, evidence, and citations connected.",
    images: [{ url: "/brand/aidoforme-cover.png", width: 3500, height: 1440 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "AidoFor.me",
    description: "Research with evidence. Write in your voice.",
    images: ["/brand/aidoforme-cover.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
