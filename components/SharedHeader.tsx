"use client";
import Image from "next/image";
import Link from "next/link";
import { useState, useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

import RecordScreen from "./RecordScreen";
import { filterOptions } from "@/constants";
import ImageWithFallback from "./ImageWithFallback";
import DropdownList from "./DropdownList";
import { updateURLParams } from "@/lib/utils";

const SharedHeader = ({
  subHeader,
  title,
  userImg,
  showSearch = true,
  showActions = true,
}: SharedHeaderProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [searchQuery, setSearchQuery] = useState(
    searchParams.get("query") || ""
  );
  const [selectedFilter, setSelectedFilter] = useState(
    searchParams.get("filter") || "Most Recent"
  );

  useEffect(() => {
    setSearchQuery(searchParams.get("query") || "");
    setSelectedFilter(searchParams.get("filter") || "Most Recent");
  }, [searchParams]);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      if (searchQuery !== searchParams.get("query")) {
        const url = updateURLParams(
          searchParams,
          { query: searchQuery || null },
          pathname
        );
        router.push(url);
      }
    }, 500);
    return () => clearTimeout(debounceTimer);
  }, [searchQuery, searchParams, pathname, router]);

  const handleFilterChange = (filter: string) => {
    setSelectedFilter(filter);
    const url = updateURLParams(
      searchParams,
      { filter: filter || null },
      pathname
    );
    router.push(url);
  };

  const renderFilterTrigger = () => (
    <span className="filter-trigger">
      <span className="filter-trigger-label">
        <Image src="/assets/icons/hamburger.svg" alt="" aria-hidden width={14} height={14} />
        <span>{selectedFilter}</span>
      </span>
      <Image src="/assets/icons/arrow-down.svg" alt="" aria-hidden width={20} height={20} />
    </span>
  );

  return (
    <header className="header">
      <section className="header-container">
        <figure className="details">
          {userImg && (
            <ImageWithFallback
              src={userImg}
              alt=""
              width={66}
              height={66}
              className="rounded-full"
            />
          )}
          <article>
            <p>{subHeader}</p>
            <h1>{title}</h1>
          </article>
        </figure>
        {showActions && (
          <aside>
            <Link href="/upload">
              <Image src="/assets/icons/upload.svg" alt="" aria-hidden width={16} height={16} />
              <span>Upload a video</span>
            </Link>
            <RecordScreen />
          </aside>
        )}
      </section>
      {showSearch && (
        <section className="search-filter">
          <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
            <label htmlFor="video-search" className="sr-only">
              Search videos by title, transcript or summary
            </label>
            <input
              id="video-search"
              type="search"
              name="query"
              autoComplete="off"
              placeholder="Search titles, transcripts and summaries…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <Image src="/assets/icons/search.svg" alt="" aria-hidden width={16} height={16} />
            {searchQuery && (
              <button
                type="button"
                className="search-clear"
                aria-label="Clear search"
                onClick={() => setSearchQuery("")}
              >
                ×
              </button>
            )}
          </form>
          <DropdownList
            options={filterOptions}
            selectedOption={selectedFilter}
            onOptionSelect={handleFilterChange}
            triggerElement={renderFilterTrigger()}
            ariaLabel="Sort videos"
          />
        </section>
      )}
    </header>
  );
};

export default SharedHeader;
