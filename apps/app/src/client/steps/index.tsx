import type { ComponentType } from "react";
import type { StepId } from "../lib/route.ts";
import { AddressStep } from "./AddressStep.tsx";
import { AreaStep } from "./AreaStep.tsx";
import { BusinessStep } from "./BusinessStep.tsx";
import { PhotosStep } from "./PhotosStep.tsx";
import { ServicesStep } from "./ServicesStep.tsx";
import { TrustStep } from "./TrustStep.tsx";
import type { StepProps } from "./types.ts";
import { WordsStep } from "./WordsStep.tsx";

export const STEP_BODY: Record<StepId, ComponentType<StepProps>> = {
  business: BusinessStep,
  services: ServicesStep,
  area: AreaStep,
  trust: TrustStep,
  photos: PhotosStep,
  words: WordsStep,
  address: AddressStep,
};
