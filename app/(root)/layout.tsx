import { Navbar } from "@/components";

const RootLayout = ({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) => {
  return (
    <div>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <Navbar />
      <div id="main-content" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
};

export default RootLayout;
