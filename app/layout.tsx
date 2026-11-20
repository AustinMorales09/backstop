import type { Metadata } from "next";
import Link from "next/link";
import { getUser } from "@/lib/auth";
import { logout } from "@/lib/actions";
import "./globals.css";
import "./theme.css";

export const metadata: Metadata = {
  title: "Backstop",
  description: "Scheduled, encrypted database backups with automatic restore checks.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@400;500;600;700;800&family=Red+Hat+Text:wght@400;500;600;700;800&family=Red+Hat+Mono:wght@400;500;600;700&display=swap" />
      </head>
      <body>
        <nav className="nav">
          <Link href={user ? "/dashboard" : "/"} className="brand">Backstop</Link>
          <div className="nav-right">
            {user ? (
              <>
                <Link href="/dashboard">Databases</Link>
                <Link href="/settings">Alerts</Link>
                <span className="small">{user.email}</span>
                <form action={logout}><button className="link">Log out</button></form>
              </>
            ) : (
              <>
                <Link href="/login">Log in</Link>
                <Link href="/signup">Sign up</Link>
              </>
            )}
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
