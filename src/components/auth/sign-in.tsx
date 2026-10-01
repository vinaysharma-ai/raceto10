import { signIn } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

/**
 * The two ways in.
 *
 * Plain forms posting to a Server Action rather than a client component with
 * `onClick` — so signing in works with JavaScript still loading, and the button
 * is a button.
 *
 * No provider logos. They would be the only images on the site, they carry
 * trademark conditions, and the labels already say which is which.
 */
export function SignInButtons({ next = "/join" }: { next?: string }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <form action={signIn.bind(null, "google", next)}>
        <Button type="submit" className="w-full sm:w-auto">
          Continue with Google
        </Button>
      </form>

      <form action={signIn.bind(null, "twitter", next)}>
        <Button type="submit" variant="secondary" className="w-full sm:w-auto">
          Continue with X
        </Button>
      </form>
    </div>
  );
}
