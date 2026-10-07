/** The Hybrid panel beside the sign-in, sign-up and invite forms (shown from 1024 px wide). Plain text, no heading: each page has one h1. */
export function AuthIntro() {
  return (
    <div className="auth-intro">
      <img src="/hybrid.png" alt="" width={56} height={56} className="auth-intro-mark" />
      <p className="auth-intro-title">Websites for your business, made with Hybrid.</p>
      <p className="auth-intro-text">
        Answer a few questions, check the draft and change what you like. A person at Hybrid Mediaworks checks every website before it goes live.
      </p>
    </div>
  );
}
