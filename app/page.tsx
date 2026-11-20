import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";

export default async function Home() {
  if (await getUser()) redirect("/dashboard");
  return (
    <main className="hero">
      <h1>Backups you&apos;ve actually tested</h1>
      <p>
        Scheduled Postgres, MySQL, and SQLite backups, compressed and encrypted. Every backup is restored and
        checked automatically, and you get an alert the moment one fails.
      </p>
      <Link href="/signup" className="btn">Protect a database</Link>
    </main>
  );
}
