import { redirect } from "next/navigation";

export default function SendRedirect() {
  redirect("/patient?step=review");
}
