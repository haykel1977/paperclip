# Next.js App with shadcn/ui Components

This is a Next.js application built with TypeScript, Tailwind CSS, and shadcn/ui components.

## Features

- Modern UI with shadcn/ui components
- Responsive design using Tailwind CSS
- TypeScript for type safety
- Component-based architecture
- Routing with Next.js pages router

## Project Structure

```
src/
├── app/
│   ├── globals.css
│   └── layout.tsx
├── components/
│   └── ui/
│       ├── button.tsx
│       ├── card.tsx
│       ├── input.tsx
│       ├── label.tsx
│       └── textarea.tsx
├── lib/
│   └── utils.ts
├── pages/
│   ├── Index.tsx
│   ├── about.tsx
│   ├── contact.tsx
│   ├── pricing.tsx
│   └── _404.tsx
└── public/
```

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the development server:
   ```bash
   npm run dev
   ```

3. Open [http://localhost:3000](http://localhost:3000) in your browser

## Available Pages

- `/` - Home page
- `/about` - About page
- `/contact` - Contact page
- `/pricing` - Pricing page
- `/404` - 404 error page

## Components Used

- Button
- Card
- Input
- Label
- Textarea

## Styling

This project uses:
- Tailwind CSS for styling
- shadcn/ui components for UI elements
- Custom global styles in `src/app/globals.css`

## Deployment

To deploy this application, you can use Vercel, Netlify, or any other platform that supports Next.js applications.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs)
- [Learn Next.js](https://nextjs.org/learn)
- [shadcn/ui Documentation](https://ui.shadcn.com/)