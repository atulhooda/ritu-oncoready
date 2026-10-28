"use client";

import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useState } from "react";

import { onSoundsChange, setSoundsOn, soundsOn } from "@/lib/sounds";

/** Turns interface sounds on or off (remembered in this browser). */
export function SoundToggle({ className = "" }: { className?: string }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    setOn(soundsOn());
    return onSoundsChange(setOn);
  }, []);
  return (
    <button
      type="button"
      onClick={() => setSoundsOn(!on)}
      title={on ? "Turn sounds off" : "Turn sounds on"}
      aria-label={on ? "Turn sounds off" : "Turn sounds on"}
      aria-pressed={on}
      className={className}
    >
      {on ? <Volume2 size={17} /> : <VolumeX size={17} />}
    </button>
  );
}
