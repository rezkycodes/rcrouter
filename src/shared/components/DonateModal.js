"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";

const BUY_ME_A_COFFEE_URL = "https://www.buymeacoffee.com/rezkycodes";

export default function DonateModal({ isOpen, onClose }) {
  const modalRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={modalRef}
        className="relative w-full max-w-md bg-surface border border-black/10 dark:border-white/10 rounded-xl shadow-2xl animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between p-3 border-b border-black/5 dark:border-white/5">
          <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-pink-500">volunteer_activism</span>
            Support RcRouter
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="p-6">
          <p className="text-text-muted text-sm mb-6 text-center">
            If RcRouter helps your work, you can support its development through Buy Me a Coffee.
          </p>
          <div className="flex flex-col items-center p-6 rounded-xl border border-black/10 dark:border-white/10 bg-surface/50 hover:border-[#ffdd00]/60 transition-colors">
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3 bg-[#ffdd00]/20 text-[#b89f00] dark:text-[#ffdd00]">
              <span className="material-symbols-outlined text-[26px]">coffee</span>
            </div>
            <div className="font-semibold text-text-main mb-1">Buy Me a Coffee</div>
            <div className="text-xs text-text-muted text-center">buymeacoffee.com/rezkycodes</div>
            <a
              href={BUY_ME_A_COFFEE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-black bg-[#ffdd00] hover:bg-[#ffe535] transition-colors"
            >
              Support
              <span className="material-symbols-outlined text-[16px]">open_in_new</span>
            </a>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

DonateModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
