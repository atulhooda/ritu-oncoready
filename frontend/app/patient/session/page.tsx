import { redirect } from "next/navigation";

export default function TalkToRituRedirect() {
  redirect("/patient?step=ritu");
}
