import type { Metadata } from "next";
import { Golos_Text, Open_Sans } from "next/font/google";
import "./globals.css";

const golosText = Golos_Text({
  variable: "--font-golos",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const openSans = Open_Sans({
  variable: "--font-open-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Ingedata - Portail Red-On-Line",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" className={`${golosText.variable} ${openSans.variable}`}>
      <body
        className="min-h-screen flex flex-col text-white bg-[#0044ff] bg-cover bg-center bg-fixed bg-no-repeat"
        style={{ backgroundImage: "url('/background.png')" }}
      >
        {children}
      </body>
    </html>
  );
}
