import type { Metadata, Viewport } from "next";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import "lenis/dist/lenis.css";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const description =
  "Non-custodial. Your wallet, your keys, and a scoped on-chain permission the bot trades inside — capped per day, venue-restricted, time-boxed, and revocable in one tap.";

export const metadata: Metadata = {
  metadataBase: new URL("https://xorr.finance"),
  title: "xorr — A bot that trades while you get on with your life",
  description,
  openGraph: {
    title: "xorr",
    description,
    url: "https://xorr.finance",
    siteName: "xorr",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "xorr",
    description,
  },
};

export const viewport: Viewport = {
  themeColor: "#030304",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${jakarta.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
