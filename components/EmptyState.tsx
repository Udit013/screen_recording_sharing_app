import Image from "next/image";

const EmptyState = ({ icon, title, description }: EmptyStateProps) => {
  return (
    <section className="empty-state">
      <figure>
        <Image src={icon} alt="" aria-hidden width={46} height={46} />
      </figure>
      <article>
        <h2>{title}</h2>
        <p>{description}</p>
      </article>
    </section>
  );
};

export default EmptyState;
