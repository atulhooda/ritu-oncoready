"use client";

import { useParams } from "next/navigation";

import { PatientJoin } from "@/components/PatientJoin";

/** A clinic's own patient sign-up link: /join/<clinic code>. */
export default function JoinClinicPage() {
  const { code } = useParams<{ code: string }>();
  return <PatientJoin code={code} />;
}
