export const metadata = {
  title: "Carta Relay",
  description: "OAuth and push relay for Carta email."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
