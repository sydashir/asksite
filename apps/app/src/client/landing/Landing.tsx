import type { ReactNode } from "react";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { onLinkClick } from "../hooks/use-route.ts";
import "./landing.css";

const STEPS = [
  ["Answer questions about your business", "It takes about 15 minutes, and you can stop and come back at any time."],
  ["Check the draft and make it yours", "We write a first draft from your answers. Change the words, the look and the photos."],
  ["Send it for review", "A person at Hybrid Mediaworks checks every website before it goes live."],
  ["Customers reach you", "Your website has a contact form. When someone uses it, the message shows up in your account and in your email."],
] as const;

const DESIGNS = [
  ["Bold", "bold-desktop", "Big headlines and strong colors. Stands out."],
  ["Classic", "classic-desktop", "Quiet and traditional, with room to breathe."],
  ["Modern", "modern-desktop", "Light and clean, easy to scan on a phone."],
] as const;

const QUESTIONS = [
  [
    "How long does it take?",
    "About 15 minutes to answer the questions, and you can stop and come back at any time. When you send your website for review, we check it before it goes live, usually within one working day.",
  ],
  ["Who checks my website?", "A person at Hybrid Mediaworks looks at every page before it goes live. If something needs a change, we email you a note."],
  [
    "Can I change it later?",
    "Yes. Edit it whenever you like and send it for review again. Your live website stays as it is until we approve the new version.",
  ],
  ["What happens after approval?", "Your website goes live at its web address, usually within about a minute, and we email you."],
  ["Do I need a password?", "No. We email you a link to log in."],
] as const;

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const FEATURES: readonly (readonly [string, string, ReactNode])[] = [
  [
    "Looks right on phones",
    "Every design is built for small screens first, and works on large ones too.",
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </>,
  ],
  [
    "A contact form that emails you",
    "Visitors can send you a message from your website. You get it by email and in your account.",
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>,
  ],
  [
    "Your own web address",
    "You choose your website's address in the last step.",
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3Z" />
    </>,
  ],
  [
    "Change it any time",
    "Edit your words, look and photos whenever you like. Changes go live after we check them again.",
    <>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
      <path d="m13.5 6.5 4 4" />
    </>,
  ],
  [
    "Checked by a person",
    "Nothing goes live until someone at Hybrid Mediaworks has looked at every page.",
    <>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6L12 3Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>,
  ],
  [
    "No tracking on your website",
    "We add no tracking scripts or cookies to your website.",
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c5 0 8.5 4.2 9.5 6-.5.9-1.4 2.1-2.7 3.2M6.6 7.7C4.6 9 3.2 10.9 2.5 12c1 1.8 4.5 6 9.5 6 1.5 0 2.8-.4 4-.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>,
  ],
];

function Actions() {
  return (
    <div className="landing-actions">
      <a className="btn-primary btn-lg" href="/signup" onClick={onLinkClick}>
        Get started
      </a>
      <a className="btn-on-dark btn-lg" href="/login" onClick={onLinkClick}>
        Log in
      </a>
    </div>
  );
}

/** The signed-out front page: what Hybrid Mediaworks offers, in plain words, with a way to start or log in. */
export default function Landing() {
  const heading = usePageHeading<HTMLHeadingElement>("Hybrid Mediaworks");
  return (
    <div className="landing">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-wrap landing-hero-grid">
          <div className="min-w-0">
            <p className="landing-eyebrow">Hybrid Mediaworks</p>
            <h1 ref={heading} tabIndex={-1} id="landing-title" className="landing-h1">
              Your business website, built from a few answers.
            </h1>
            <p className="landing-lead">
              Answer questions about your business, check the draft we write for you, and change anything you like. A person at Hybrid Mediaworks checks every
              website before it goes live.
            </p>
            <Actions />
            <p className="landing-note">No password. We email you a link.</p>
          </div>
          <figure className="landing-visual m-0">
            <div className="landing-board">
              <img
                className="landing-shot"
                src="/landing/bold-desktop.webp"
                alt="The home page of a sample plumbing website in the Bold design"
                width={960}
                height={640}
                loading="eager"
                decoding="async"
              />
            </div>
            <div className="landing-phone hidden sm:block">
              <img
                className="landing-shot"
                src="/landing/bold-phone.webp"
                alt="The same sample website on a phone"
                width={240}
                height={480}
                loading="eager"
                decoding="async"
              />
            </div>
            <figcaption className="landing-caption">Sample website for a made-up business, Bold design.</figcaption>
          </figure>
        </div>
      </section>

      <section id="how" className="landing-dark" aria-labelledby="landing-how">
        <div className="landing-wrap">
          <h2 id="landing-how" className="landing-h2">
            How it works
          </h2>
          <ol className="landing-steps">
            {STEPS.map(([title, text], i) => (
              <li key={title} className="landing-card">
                <span className="landing-disc" aria-hidden="true">
                  {i + 1}
                </span>
                <h3 className="landing-h3">{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="designs" className="landing-dark" aria-labelledby="landing-designs">
        <div className="landing-wrap">
          <h2 id="landing-designs" className="landing-h2">
            Three designs to choose from
          </h2>
          <p className="landing-intro">Every website starts on the design that suits its trade. You can switch to another one in the editor. The examples are for a made-up business.</p>
          <div className="landing-designs">
            {DESIGNS.map(([name, file, text]) => (
              <article key={name} className="landing-design">
                <img src={`/landing/${file}.webp`} alt={`A sample website in the ${name} design`} width={960} height={640} loading="lazy" decoding="async" />
                <div>
                  <h3 className="landing-h3">{name}</h3>
                  <p>{text}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="landing-paper" aria-labelledby="landing-features">
        <div className="landing-wrap">
          <h2 id="landing-features" className="landing-h2">
            What you get
          </h2>
          <ul className="landing-features">
            {FEATURES.map(([title, text, icon]) => (
              <li key={title}>
                <span className="icon-tile">
                  <Icon>{icon}</Icon>
                </span>
                <h3 className="landing-h3">{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="questions" className="landing-dark" aria-labelledby="landing-questions">
        <div className="landing-wrap">
          <h2 id="landing-questions" className="landing-h2">
            Questions
          </h2>
          <div className="landing-faq">
            {QUESTIONS.map(([question, answer]) => (
              <details key={question}>
                <summary>{question}</summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-cta" aria-labelledby="landing-cta">
        <div className="landing-wrap">
          <h2 id="landing-cta" className="landing-h2">
            Ready to build your website?
          </h2>
          <p className="landing-intro">Answer a few questions and see your first draft today.</p>
          <Actions />
        </div>
      </section>
    </div>
  );
}
